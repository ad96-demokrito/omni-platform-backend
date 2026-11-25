import { query, queryOne } from "../../db/pool";
import { emailService } from "../email/email.service";
import { logger } from "../../utils/logger";
import { invoiceBccEmail, invoiceEmailEnabled, invoicePdfAttach } from "./config";
import { getDocumentPdf, getInvoicePdf, issueDocumentPdf, issueInvoicePdf, PdfDocumentKind } from "./invoice-pdf.service";
import { mapCreditNoteRow, mapPaymentRow } from "./payment-record";

/**
 * Emails an issued invoice to the workspace owner (plan/018).
 *
 * Switches (all in .env):
 *   INVOICE_EMAIL_ENABLED  master switch. false = nothing is emailed; the PDF is still created and downloadable.
 *   INVOICE_PDF_ATTACH     false = the email carries the HTML receipt only, no PDF attachment.
 *   INVOICE_BCC_EMAIL      optional silent copy for the accountant.
 *
 * Sending never blocks or breaks a payment: the outcome is stored on the ledger row (email_status), a failed send
 * is retried by the hourly job (up to MAX_ATTEMPTS) and an admin can resend by hand.
 */
const log = logger.child({ module: "invoice-delivery" });

const MAX_ATTEMPTS = 5;
const RETRY_WINDOW_DAYS = 14;
const RETRY_BATCH = 25;
const MAX_ERROR_LENGTH = 200;

export type DeliveryOutcome = "sent" | "failed" | "disabled" | "no_recipient" | "not_configured" | "not_found";

// Work started after a payment was recorded. Tracked so a graceful shutdown (and the tests) can wait for it.
const pendingWork = new Set<Promise<unknown>>();

export function trackInvoiceWork(work: Promise<unknown>): void {
  const tracked = work.catch((err) => log.error("invoice follow-up work failed", { reason: (err as Error)?.message }));
  pendingWork.add(tracked);
  void tracked.finally(() => pendingWork.delete(tracked));
}

/** Resolves when every invoice PDF / email started so far has finished. */
export async function waitForInvoiceWork(): Promise<void> {
  while (pendingWork.size > 0) await Promise.all([...pendingWork]);
}

interface DeliveryRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  tenant_name: string;
  invoice_number: string;
  notes: string | null;
  email_attempts: number;
  owner_email: string | null;
}

async function loadDeliveryRow(paymentId: string): Promise<DeliveryRow | null> {
  const row = await queryOne<DeliveryRow>(
    `SELECT psp.*, t.name AS tenant_name,
            (SELECT u.email FROM users u
              WHERE u.tenant_id = psp.tenant_id AND u.role = 'owner' AND u.status = 'active'
              ORDER BY u.created_at LIMIT 1) AS owner_email
     FROM platform_subscription_payments psp
     JOIN tenants t ON t.id = psp.tenant_id
     WHERE psp.id = $1`,
    [paymentId]
  );
  return row ?? null;
}

const TABLE: Record<PdfDocumentKind, string> = {
  invoice: "platform_subscription_payments",
  credit_note: "billing_credit_notes",
};

async function setStatus(
  paymentId: string,
  status: "none" | "pending" | "sent" | "failed",
  fields: { attempt?: boolean; error?: string | null } = {},
  kind: PdfDocumentKind = "invoice"
): Promise<void> {
  await query(
    `UPDATE ${TABLE[kind]}
     SET email_status = $2,
         email_attempts = email_attempts + $3,
         email_last_error = $4,
         emailed_at = CASE WHEN $2 = 'sent' THEN now() ELSE emailed_at END
     WHERE id = $1`,
    [paymentId, status, fields.attempt ? 1 : 0, fields.error ? fields.error.slice(0, MAX_ERROR_LENGTH) : null]
  );
}

/** Sends (or re-sends) the invoice email of one ledger row, honouring the env switches. Never throws. */
export async function deliverInvoiceEmail(paymentId: string): Promise<DeliveryOutcome> {
  try {
    const row = await loadDeliveryRow(paymentId);
    if (!row) return "not_found";

    if (!invoiceEmailEnabled()) {
      await setStatus(paymentId, "none");
      return "disabled";
    }
    if (!row.owner_email) {
      await setStatus(paymentId, "failed", { attempt: true, error: "The workspace has no active owner email" });
      return "no_recipient";
    }

    let pdf: { fileName: string; content: Buffer } | undefined;
    if (invoicePdfAttach()) {
      try {
        const generated = await getInvoicePdf(paymentId);
        if (generated) pdf = { fileName: generated.fileName, content: generated.pdf };
      } catch (err) {
        // The receipt still goes out; the PDF stays downloadable from the app.
        log.error("invoice PDF could not be attached", { paymentId, reason: (err as Error)?.message });
      }
    }

    const record = mapPaymentRow(row, row.tenant_name);
    const result = await emailService.sendSubscriptionReceipt({
      to: row.owner_email,
      tenantName: row.tenant_name,
      planName: record.planName,
      invoiceNumber: record.invoiceNumber,
      amount: record.amount,
      currency: record.currency,
      billingCycle: record.billingCycle,
      periodEnd: record.periodEnd,
      paymentMethod: record.paymentMethod,
      subtotal: record.subtotal,
      taxAmount: record.taxAmount,
      taxRate: record.taxRate,
      taxLabel: record.taxLabel,
      buyerTaxId: record.buyerTaxId,
      sellerTaxId: record.sellerTaxId,
      sellerLegalName: record.sellerName,
      pdf,
      bcc: invoiceBccEmail() ?? undefined,
      isRenewal: (row.notes ?? "").startsWith("Automatic renewal"),
    });

    if (result.success && !result.simulated) {
      await setStatus(paymentId, "sent", { attempt: true });
      return "sent";
    }
    if (result.success && result.simulated) {
      // No SMTP configured: nothing left the building, and a retry would not change that.
      await setStatus(paymentId, "none", { error: "Email is not configured (SMTP_* is empty), nothing was sent" });
      return "not_configured";
    }
    await setStatus(paymentId, "failed", { attempt: true, error: result.error ?? "Sending failed" });
    return "failed";
  } catch (err) {
    log.error("invoice email failed", { paymentId, reason: (err as Error)?.message });
    await setStatus(paymentId, "failed", { attempt: true, error: (err as Error)?.message ?? "Sending failed" }).catch(() => {});
    return "failed";
  }
}

/**
 * Right after an invoice is issued: create and store its PDF, then email it (when asked to and enabled).
 * Runs in the background; see `waitForInvoiceWork`.
 */
export function startInvoiceFollowUp(paymentId: string, options: { email: boolean }): void {
  trackInvoiceWork(
    (async () => {
      if (options.email && invoiceEmailEnabled()) {
        // Marked first, so a crash between here and the send leaves a row the retry job will pick up.
        await setStatus(paymentId, "pending");
      }
      await issueInvoicePdf(paymentId);
      if (options.email) await deliverInvoiceEmail(paymentId);
    })()
  );
}

/** Sends (or re-sends) a credit note by email to the workspace owner, honouring the same env switches. Never throws. */
export async function deliverCreditNoteEmail(creditNoteId: string): Promise<DeliveryOutcome> {
  try {
    const row = await queryOne<Record<string, unknown> & { owner_email: string | null; tenant_name: string }>(
      `SELECT cn.*, t.name AS tenant_name,
              (SELECT invoice_number FROM platform_subscription_payments WHERE id = cn.invoice_id) AS invoice_number,
              (SELECT invoice_number FROM platform_subscription_payments WHERE id = cn.applied_to_invoice_id) AS applied_to_invoice_number,
              (SELECT u.email FROM users u
                WHERE u.tenant_id = cn.tenant_id AND u.role = 'owner' AND u.status = 'active'
                ORDER BY u.created_at LIMIT 1) AS owner_email
       FROM billing_credit_notes cn JOIN tenants t ON t.id = cn.tenant_id
       WHERE cn.id = $1`,
      [creditNoteId]
    );
    if (!row) return "not_found";
    if (!invoiceEmailEnabled()) {
      await setStatus(creditNoteId, "none", {}, "credit_note");
      return "disabled";
    }
    if (!row.owner_email) {
      await setStatus(creditNoteId, "failed", { attempt: true, error: "The workspace has no active owner email" }, "credit_note");
      return "no_recipient";
    }

    let pdf: { fileName: string; content: Buffer } | undefined;
    if (invoicePdfAttach()) {
      try {
        const generated = await getDocumentPdf("credit_note", creditNoteId);
        if (generated) pdf = { fileName: generated.fileName, content: generated.pdf };
      } catch (err) {
        log.error("credit note PDF could not be attached", { creditNoteId, reason: (err as Error)?.message });
      }
    }

    const note = mapCreditNoteRow(row, row.tenant_name);
    const result = await emailService.sendCreditNote({
      to: row.owner_email,
      tenantName: row.tenant_name,
      creditNoteNumber: note.creditNoteNumber,
      invoiceNumber: note.invoiceNumber,
      appliedToInvoiceNumber: note.appliedToInvoiceNumber,
      total: note.total,
      currency: note.currency,
      reason: note.reason,
      pdf,
      bcc: invoiceBccEmail() ?? undefined,
    });

    if (result.success && !result.simulated) {
      await setStatus(creditNoteId, "sent", { attempt: true }, "credit_note");
      return "sent";
    }
    if (result.success && result.simulated) {
      await setStatus(creditNoteId, "none", { error: "Email is not configured (SMTP_* is empty), nothing was sent" }, "credit_note");
      return "not_configured";
    }
    await setStatus(creditNoteId, "failed", { attempt: true, error: result.error ?? "Sending failed" }, "credit_note");
    return "failed";
  } catch (err) {
    log.error("credit note email failed", { creditNoteId, reason: (err as Error)?.message });
    await setStatus(creditNoteId, "failed", { attempt: true, error: (err as Error)?.message ?? "Sending failed" }, "credit_note").catch(() => {});
    return "failed";
  }
}

/** Right after a credit note was issued: create and store its PDF, then email it. Runs in the background. */
export function startCreditNoteFollowUp(creditNoteId: string, options: { email: boolean }): void {
  trackInvoiceWork(
    (async () => {
      if (options.email && invoiceEmailEnabled()) await setStatus(creditNoteId, "pending", {}, "credit_note");
      await issueDocumentPdf("credit_note", creditNoteId);
      if (options.email) await deliverCreditNoteEmail(creditNoteId);
    })()
  );
}

/** Hourly job: tries again for invoice and credit note emails that failed (or never finished), a few times each. */
export async function retryInvoiceEmails(): Promise<number> {
  if (!invoiceEmailEnabled()) return 0;
  let sent = 0;
  let tried = 0;
  for (const kind of ["invoice", "credit_note"] as const) {
    const due = await query<{ id: string }>(
      `SELECT id FROM ${TABLE[kind]}
       WHERE email_status IN ('pending', 'failed')
         AND email_attempts < $1
         AND issued_at > now() - make_interval(days => $2::int)
       ORDER BY issued_at
       LIMIT $3`,
      [MAX_ATTEMPTS, RETRY_WINDOW_DAYS, RETRY_BATCH]
    );
    for (const { id } of due) {
      tried += 1;
      const outcome = kind === "invoice" ? await deliverInvoiceEmail(id) : await deliverCreditNoteEmail(id);
      if (outcome === "sent") sent += 1;
    }
  }
  if (tried > 0) log.info("invoice email retry pass", { tried, sent });
  return sent;
}
