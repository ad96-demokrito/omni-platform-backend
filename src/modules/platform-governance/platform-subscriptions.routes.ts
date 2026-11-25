import { Router, Response } from "express";
import { asyncHandler } from "../../middleware/async-handler";
import {
  requirePlatformAuth,
  requirePlatformRole,
  logPlatformAudit,
  PlatformAuthedRequest,
} from "../../middleware/platform-auth";
import {
  listWorkspaceSubscriptions,
  updateTenantSubscriptionLifecycle,
  recordSubscriptionPayment,
  setWorkspaceBillingCountry,
  listSubscriptionPayments,
} from "./platform-subscriptions.service";
import { deliverInvoiceEmail } from "../billing/invoice-delivery.service";
import { getDocumentPdf, getInvoicePdf } from "../billing/invoice-pdf.service";
import { createCreditNote, getCreditNote, listCreditNotes } from "../billing/credit-notes.service";
import { deliverCreditNoteEmail } from "../billing/invoice-delivery.service";
import { buildMonthlyPackage, buildRegisterCsv, loadMonthlyRegister } from "../billing/invoice-export.service";
import { rateLimitByIp } from "../../middleware/rate-limit";
import { httpError, isUuid } from "../../utils/http-error";

export const platformSubscriptionsRouter = Router();

platformSubscriptionsRouter.use(requirePlatformAuth);

/**
 * GET /api/platform/subscriptions
 * List all workspace subscriptions with days remaining & quota metrics
 */
platformSubscriptionsRouter.get(
  "/",
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const { search, status, planId, page, limit } = req.query;
    const result = await listWorkspaceSubscriptions({
      search: search as string,
      status: status as string,
      planId: planId as string,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
    res.json(result);
  })
);

/**
 * PUT /api/platform/subscriptions/:tenantId
 * Modify a workspace subscription status, expiration, or quota limits
 */
platformSubscriptionsRouter.put(
  "/:tenantId",
  requirePlatformRole("super_admin", "support_agent"),
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const { tenantId } = req.params;
    const {
      planId,
      planStatus,
      planExpiresAt,
      maxChannels,
      maxContacts,
      maxMonthlyMessages,
      maxMonthlyAiQueries,
    } = req.body;

    const updated = await updateTenantSubscriptionLifecycle({
      tenantId,
      planId,
      planStatus,
      planExpiresAt,
      maxChannels: maxChannels !== undefined ? Number(maxChannels) : undefined,
      maxContacts: maxContacts !== undefined ? Number(maxContacts) : undefined,
      maxMonthlyMessages: maxMonthlyMessages !== undefined ? Number(maxMonthlyMessages) : undefined,
      maxMonthlyAiQueries: maxMonthlyAiQueries !== undefined ? Number(maxMonthlyAiQueries) : undefined,
    });

    await logPlatformAudit({
      platformUser: req.platformUser!,
      action: "subscription.lifecycle_update",
      targetType: "tenant_subscription",
      targetId: tenantId,
      details: {
        planId,
        planStatus,
        planExpiresAt,
        tenantName: updated.tenantName,
      },
      req,
    });

    res.json(updated);
  })
);

/**
 * PUT /api/platform/subscriptions/:tenantId/billing
 * Change a workspace's billing country (and so its currency), also after the currency locked.
 * Body: { country: "IN", resetLock?: boolean }. Super admin only; audited.
 */
platformSubscriptionsRouter.put(
  "/:tenantId/billing",
  requirePlatformRole("super_admin"),
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const { tenantId } = req.params;
    const { country, resetLock = false } = req.body || {};

    let result;
    try {
      result = await setWorkspaceBillingCountry(tenantId, country, Boolean(resetLock));
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : "Could not update billing country" });
    }

    await logPlatformAudit({
      platformUser: req.platformUser!,
      action: "subscription.billing_country",
      targetType: "tenant_subscription",
      targetId: tenantId,
      details: { country: result.billingCountry, currency: result.billingCurrency, resetLock: Boolean(resetLock) },
      req,
    });

    res.json(result);
  })
);

/**
 * POST /api/platform/subscriptions/:tenantId/renew
 * Quick renew a workspace subscription by N days or standard billing cycle
 */
platformSubscriptionsRouter.post(
  "/:tenantId/renew",
  requirePlatformRole("super_admin", "support_agent"),
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const { tenantId } = req.params;
    const {
      planId,
      amount,
      currency,
      billingCycle = "monthly",
      paymentMethod = "manual",
      sendReceipt = true,
      notes,
    } = req.body;

    if (!planId || amount === undefined) {
      return res.status(400).json({ error: "planId and amount are required to record renewal" });
    }

    const result = await recordSubscriptionPayment({
      tenantId,
      planId,
      amount: Number(amount),
      // Defaults to the workspace's billing currency when the portal does not send one.
      currency: typeof currency === "string" && currency ? currency : undefined,
      billingCycle,
      paymentMethod,
      notes: notes || "Manual administrative renewal via Platform Portal",
      sendReceiptEmail: Boolean(sendReceipt),
      staffId: req.platformUser?.id,
      staffName: req.platformUser?.name,
    });

    await logPlatformAudit({
      platformUser: req.platformUser!,
      action: "subscription.renew",
      targetType: "tenant_subscription",
      targetId: tenantId,
      details: {
        invoiceNumber: result.payment.invoiceNumber,
        amount: result.payment.amount,
        planName: result.payment.planName,
        tenantName: result.subscription.tenantName,
      },
      req,
    });

    res.status(201).json(result);
  })
);

// ─────────────────────────────────────────────────────────────
// Payments Ledger Router
// ─────────────────────────────────────────────────────────────
export const platformPaymentsRouter = Router();

/** A calendar month as "YYYY-MM". */
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
platformPaymentsRouter.use(requirePlatformAuth);

/**
 * GET /api/platform/payments
 * List payment transaction ledger & revenue metrics
 */
platformPaymentsRouter.get(
  "/",
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const { tenantId, status, search, page, limit, month } = req.query;
    if (month !== undefined && !MONTH_PATTERN.test(String(month))) {
      throw httpError(400, "month must look like 2026-11");
    }
    const result = await listSubscriptionPayments({
      tenantId: tenantId as string,
      status: status as string,
      search: search as string,
      month: month as string | undefined,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
    res.json(result);
  })
);

/**
 * POST /api/platform/payments
 * Record a manual subscription payment / invoice entry
 */
/**
 * GET /api/platform/payments/export?month=2026-11[&format=zip|csv]
 * The monthly package for the accountant: GST register, tax summary, gateway reconciliation and every invoice PDF
 * (zip, the default) or just the register (csv). Months are India time. Super admin and finance; audited.
 */
platformPaymentsRouter.get(
  "/export",
  requirePlatformRole("super_admin", "finance"),
  rateLimitByIp("billing-export", 10, 10 * 60),
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const month = String(req.query.month ?? "");
    const format = String(req.query.format ?? "zip");
    if (!MONTH_PATTERN.test(month)) throw httpError(400, "month must look like 2026-11");
    if (format !== "zip" && format !== "csv") throw httpError(400, "format must be zip or csv");

    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (format === "csv") {
      const register = await loadMonthlyRegister(month);
      await logPlatformAudit({
        platformUser: req.platformUser!,
        action: "billing.export",
        targetType: "billing_month",
        targetId: month,
        details: { format, documents: register.length },
        req,
      });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="gst-register-${month}.csv"`);
      res.send(buildRegisterCsv(register));
      return;
    }

    const pack = await buildMonthlyPackage(month);
    await logPlatformAudit({
      platformUser: req.platformUser!,
      action: "billing.export",
      targetType: "billing_month",
      targetId: month,
      details: { format, documents: pack.documents, missingPdfs: pack.missingPdfs.length },
      req,
    });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${pack.fileName}"`);
    res.setHeader("X-Export-Documents", String(pack.documents));
    res.setHeader("X-Export-Missing-Pdfs", String(pack.missingPdfs.length));
    res.send(Buffer.from(pack.zip));
  })
);

/** GET /api/platform/payments/credit-notes?month=YYYY-MM&tenantId=... Credit notes, newest first (any platform role that may read payments). */
platformPaymentsRouter.get(
  "/credit-notes",
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const month = req.query.month === undefined ? undefined : String(req.query.month);
    if (month !== undefined && !MONTH_PATTERN.test(month)) throw httpError(400, "month must look like 2026-11");
    const tenantId = typeof req.query.tenantId === "string" && isUuid(req.query.tenantId) ? req.query.tenantId : undefined;
    res.json({ creditNotes: await listCreditNotes({ month, tenantId, limit: 200 }) });
  })
);

platformPaymentsRouter.get(
  "/credit-notes/:id/pdf",
  requirePlatformRole("super_admin", "support_agent", "finance"),
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const note = await getCreditNote(req.params.id);
    const result = note ? await getDocumentPdf("credit_note", note.id) : null;
    if (!result) throw httpError(404, "Credit note not found");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${result.fileName}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(result.pdf);
  })
);

/**
 * POST /api/platform/payments/:id/credit-notes   { kind, reason, total? }
 * Credit (part of) an invoice: a refund, a cancellation or a correction. Leave `total` out to credit what is left.
 * The money itself is paid back in the Razorpay / Stripe dashboard. Super admin only; audited.
 */
platformPaymentsRouter.post(
  "/:id/credit-notes",
  requirePlatformRole("super_admin"),
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    if (!isUuid(req.params.id)) throw httpError(404, "Invoice not found");
    const { kind, reason, total } = req.body || {};
    if (!["refund", "cancellation", "correction"].includes(kind)) {
      throw httpError(400, "kind must be refund, cancellation or correction");
    }
    if (typeof reason !== "string" || !reason.trim()) throw httpError(400, "A reason is required");
    if (total !== undefined && (typeof total !== "number" || !Number.isFinite(total) || total <= 0)) {
      throw httpError(400, "total must be a positive number (tax included), or left out to credit the rest");
    }
    const note = await createCreditNote({
      invoiceId: req.params.id,
      kind,
      reason,
      total,
      issuedBy: `staff:${req.platformUser!.email}`,
    });
    await logPlatformAudit({
      platformUser: req.platformUser!,
      action: "credit_note.issue",
      targetType: "subscription_payment",
      targetId: req.params.id,
      details: { creditNote: note.creditNoteNumber, kind, total: note.total, currency: note.currency },
      req,
    });
    res.status(201).json({ creditNote: note });
  })
);

/** POST /api/platform/payments/credit-notes/:id/resend  Emails a credit note to the workspace owner again. */
platformPaymentsRouter.post(
  "/credit-notes/:id/resend",
  requirePlatformRole("super_admin", "support_agent"),
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    if (!isUuid(req.params.id)) throw httpError(404, "Credit note not found");
    const outcome = await deliverCreditNoteEmail(req.params.id);
    if (outcome === "not_found") throw httpError(404, "Credit note not found");
    res.json({ outcome });
  })
);

platformPaymentsRouter.get(
  "/:id/invoice.pdf",
  requirePlatformRole("super_admin", "support_agent", "finance"),
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const result = isUuid(req.params.id) ? await getInvoicePdf(req.params.id) : null;
    if (!result) throw httpError(404, "Invoice not found");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${result.fileName}"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(result.pdf);
  })
);

/**
 * POST /api/platform/payments/:id/resend-invoice
 * Emails the invoice to the workspace owner again (honours INVOICE_EMAIL_ENABLED / INVOICE_PDF_ATTACH).
 */
platformPaymentsRouter.post(
  "/:id/resend-invoice",
  requirePlatformRole("super_admin", "support_agent"),
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    if (!isUuid(req.params.id)) throw httpError(404, "Invoice not found");
    const outcome = await deliverInvoiceEmail(req.params.id);
    if (outcome === "not_found") throw httpError(404, "Invoice not found");
    await logPlatformAudit({
      platformUser: req.platformUser!,
      action: "invoice.resend",
      targetType: "subscription_payment",
      targetId: req.params.id,
      details: { outcome },
      req,
    });
    res.json({ outcome });
  })
);

platformPaymentsRouter.post(
  "/",
  requirePlatformRole("super_admin", "support_agent"),
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const {
      tenantId,
      planId,
      amount,
      currency,
      billingCycle,
      paymentMethod,
      transactionReference,
      periodStart,
      periodEnd,
      durationDays,
      notes,
      sendReceiptEmail,
    } = req.body;

    if (!tenantId || !planId || amount === undefined) {
      return res.status(400).json({ error: "tenantId, planId, and amount are required" });
    }

    const result = await recordSubscriptionPayment({
      tenantId,
      planId,
      amount: Number(amount),
      currency,
      billingCycle,
      paymentMethod,
      transactionReference,
      periodStart,
      periodEnd,
      durationDays: durationDays ? Number(durationDays) : undefined,
      notes,
      sendReceiptEmail: sendReceiptEmail !== undefined ? Boolean(sendReceiptEmail) : true,
      staffId: req.platformUser?.id,
      staffName: req.platformUser?.name,
    });

    await logPlatformAudit({
      platformUser: req.platformUser!,
      action: "payment.record_entry",
      targetType: "platform_subscription_payment",
      targetId: result.payment.id,
      details: {
        invoiceNumber: result.payment.invoiceNumber,
        amount: result.payment.amount,
        tenantId,
        planId,
      },
      req,
    });

    res.status(201).json(result);
  })
);
