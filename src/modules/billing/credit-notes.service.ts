import type { PoolClient } from "pg";
import { query, queryOne, withTransaction } from "../../db/pool";
import { httpError, isUuid } from "../../utils/http-error";
import { BillingCurrency, toMinorUnits } from "./currency";
import { splitTaxAmount } from "./gst";
import { startCreditNoteFollowUp } from "./invoice-delivery.service";
import { allocateDocumentNumber, indiaMonthRange } from "./invoice-number";
import { CreditNoteRecord, mapCreditNoteRow } from "./payment-record";

/**
 * Credit notes (plan/018, Phase D). GST requires one whenever an invoiced value is reduced or refunded: its own
 * consecutive number (CN/26-27/000001), a reference to the original invoice, and the tax reversed. They are also how
 * an upgrade credits the unused part of the old invoice.
 *
 * Rules enforced here, inside the same transaction that inserts the note:
 *  - only a tax invoice can be credited (not a free-plan record, not a legacy receipt);
 *  - the credit notes of one invoice never add up to more than the invoice;
 *  - subtotal + tax always equals the credited total, to the paisa, and a final credit takes exactly what is left.
 */
export type CreditNoteKind = "upgrade_credit" | "refund" | "cancellation" | "correction";

interface InvoiceForCredit {
  id: string;
  tenant_id: string;
  amount: string;
  subtotal: string;
  tax_amount: string;
  tax_rate: string;
  currency: string;
  status: string;
  supply_type: string | null;
  cgst_amount: string;
  seller_name: string | null;
  seller_address: string | null;
  seller_state_code: string | null;
  seller_tax_id: string | null;
  buyer_name: string | null;
  buyer_address: string | null;
  buyer_state_code: string | null;
  buyer_tax_id: string | null;
  place_of_supply: string | null;
  sac_code: string | null;
  lut_number: string | null;
}

export interface IssueCreditNoteParams {
  invoiceId: string;
  kind: CreditNoteKind;
  reason: string;
  /** What is credited, tax included. */
  total: number;
  /** An exact split (an upgrade works it out by proration). Without it the split follows the invoice's own ratio. */
  split?: { subtotal: number; tax: number };
  appliedToInvoiceId?: string | null;
  issuedBy: string;
  issuedAt?: Date;
  /** When set the invoice must belong to this workspace (tenant-facing callers). */
  tenantId?: string;
}

const MAX_REASON_LENGTH = 500;

/** Issues a credit note using the caller's transaction. Returns the new credit note's id. */
export async function issueCreditNote(client: PoolClient, params: IssueCreditNoteParams): Promise<string> {
  if (!Number.isFinite(params.total) || params.total <= 0) {
    throw httpError(400, "The credit amount must be more than zero");
  }
  const reason = params.reason.trim();
  if (!reason) throw httpError(400, "A reason is required for a credit note");
  if (reason.length > MAX_REASON_LENGTH) throw httpError(400, `The reason must be ${MAX_REASON_LENGTH} characters or fewer`);

  const invoice = (
    await client.query<InvoiceForCredit>(
      `SELECT id, tenant_id, amount, subtotal, tax_amount, tax_rate, currency, status, supply_type, cgst_amount,
              seller_name, seller_address, seller_state_code, seller_tax_id, buyer_name, buyer_address,
              buyer_state_code, buyer_tax_id, place_of_supply, sac_code, lut_number
       FROM platform_subscription_payments WHERE id = $1 FOR UPDATE`,
      [params.invoiceId]
    )
  ).rows[0];
  if (!invoice || (params.tenantId && invoice.tenant_id !== params.tenantId)) throw httpError(404, "Invoice not found");
  if (!invoice.supply_type) {
    throw httpError(400, "This invoice was issued before GST tax invoices, so a credit note cannot be created here.");
  }
  if (Number(invoice.amount) <= 0 || !["paid", "refunded"].includes(invoice.status)) {
    throw httpError(400, "Only a paid invoice can be credited");
  }

  const currency = invoice.currency.trim() as BillingCurrency;
  const invoiceMinor = toMinorUnits(Number(invoice.amount), currency);
  const invoiceTaxMinor = toMinorUnits(Number(invoice.tax_amount), currency);
  const credited = (
    await client.query<{ total: string; tax: string }>(
      "SELECT COALESCE(SUM(total), 0) AS total, COALESCE(SUM(tax_amount), 0) AS tax FROM billing_credit_notes WHERE invoice_id = $1",
      [invoice.id]
    )
  ).rows[0];
  const creditedMinor = toMinorUnits(Number(credited.total), currency);
  const creditedTaxMinor = toMinorUnits(Number(credited.tax), currency);

  const totalMinor = toMinorUnits(params.total, currency);
  if (!Number.isFinite(totalMinor) || totalMinor <= 0) throw httpError(400, "The credit amount must be more than zero");
  if (creditedMinor + totalMinor > invoiceMinor) {
    throw httpError(409, "The credit notes of this invoice would add up to more than the invoice.", {
      code: "CREDIT_EXCEEDS_INVOICE",
    });
  }

  let taxMinor: number;
  if (params.split) {
    taxMinor = toMinorUnits(params.split.tax, currency);
    if (toMinorUnits(params.split.subtotal, currency) + taxMinor !== totalMinor) {
      throw new Error("Credit note split does not add up to its total");
    }
  } else if (creditedMinor + totalMinor === invoiceMinor) {
    taxMinor = invoiceTaxMinor - creditedTaxMinor; // the last credit takes exactly what is left
  } else {
    taxMinor = Math.round((totalMinor * invoiceTaxMinor) / invoiceMinor);
  }
  taxMinor = Math.max(0, Math.min(taxMinor, totalMinor));
  const subtotalMinor = totalMinor - taxMinor;

  const sameState = Number(invoice.cgst_amount) > 0;
  const tax = splitTaxAmount(taxMinor / 100, currency, sameState);
  const issuedAt = params.issuedAt ?? new Date();
  const number = await allocateDocumentNumber(client, "credit_note", issuedAt);

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO billing_credit_notes (
       tenant_id, credit_note_number, invoice_id, kind, reason, currency, subtotal, tax_rate,
       cgst_amount, sgst_amount, igst_amount, tax_amount, total, applied_to_invoice_id,
       seller_name, seller_address, seller_state_code, seller_tax_id, buyer_name, buyer_address, buyer_state_code,
       buyer_tax_id, place_of_supply, sac_code, supply_type, lut_number, issued_by, issued_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)
     RETURNING id`,
    [
      invoice.tenant_id,
      number,
      invoice.id,
      params.kind,
      reason,
      currency,
      subtotalMinor / 100,
      Number(invoice.tax_rate),
      tax.cgst,
      tax.sgst,
      tax.igst,
      taxMinor / 100,
      totalMinor / 100,
      params.appliedToInvoiceId ?? null,
      invoice.seller_name,
      invoice.seller_address,
      invoice.seller_state_code,
      invoice.seller_tax_id,
      invoice.buyer_name,
      invoice.buyer_address,
      invoice.buyer_state_code,
      invoice.buyer_tax_id,
      invoice.place_of_supply,
      invoice.sac_code,
      invoice.supply_type,
      invoice.lut_number,
      params.issuedBy,
      issuedAt.toISOString(),
    ]
  );

  if ((params.kind === "refund" || params.kind === "cancellation") && creditedMinor + totalMinor === invoiceMinor) {
    await client.query("UPDATE platform_subscription_payments SET status = 'refunded' WHERE id = $1", [invoice.id]);
  }
  return inserted.rows[0].id;
}

const SELECT_NOTE = `
  SELECT cn.*, t.name AS tenant_name,
         inv.invoice_number AS invoice_number,
         applied.invoice_number AS applied_to_invoice_number
  FROM billing_credit_notes cn
  JOIN tenants t ON t.id = cn.tenant_id
  JOIN platform_subscription_payments inv ON inv.id = cn.invoice_id
  LEFT JOIN platform_subscription_payments applied ON applied.id = cn.applied_to_invoice_id`;

export async function getCreditNote(id: string, tenantId?: string): Promise<CreditNoteRecord | null> {
  if (!isUuid(id)) return null;
  const row = await queryOne<Record<string, unknown>>(
    `${SELECT_NOTE} WHERE cn.id = $1 ${tenantId ? "AND cn.tenant_id = $2" : ""}`,
    tenantId ? [id, tenantId] : [id]
  );
  return row ? mapCreditNoteRow(row, String(row.tenant_name)) : null;
}

/** Credit notes, newest first. A tenant caller passes its own `tenantId`; platform callers may filter by month. */
export async function listCreditNotes(filters: {
  tenantId?: string;
  invoiceId?: string;
  /** "YYYY-MM", India time. */
  month?: string;
  limit?: number;
} = {}): Promise<CreditNoteRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.tenantId) {
    params.push(filters.tenantId);
    conditions.push(`cn.tenant_id = $${params.length}`);
  }
  if (filters.invoiceId) {
    params.push(filters.invoiceId);
    conditions.push(`cn.invoice_id = $${params.length}`);
  }
  if (filters.month) {
    const range = indiaMonthRange(filters.month);
    if (!range) throw httpError(400, "month must look like 2026-11");
    params.push(range.from.toISOString(), range.to.toISOString());
    conditions.push(`cn.issued_at >= $${params.length - 1} AND cn.issued_at < $${params.length}`);
  }
  params.push(Math.min(200, Math.max(1, filters.limit ?? 50)));
  const rows = await query<Record<string, unknown>>(
    `${SELECT_NOTE} ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY cn.issued_at DESC LIMIT $${params.length}`,
    params
  );
  return rows.map((row) => mapCreditNoteRow(row, String(row.tenant_name)));
}

/** A credit note raised by a person (a refund, a cancellation, a correction). Its PDF is created and emailed. */
export async function createCreditNote(params: {
  invoiceId: string;
  kind: Exclude<CreditNoteKind, "upgrade_credit">;
  reason: string;
  /** Tax included. Leave out to credit whatever is left of the invoice. */
  total?: number;
  issuedBy: string;
}): Promise<CreditNoteRecord> {
  const id = await withTransaction(async (client) => {
    let total = params.total;
    if (total === undefined) {
      const left = (
        await client.query<{ remaining: string }>(
          `SELECT p.amount - COALESCE((SELECT SUM(total) FROM billing_credit_notes WHERE invoice_id = p.id), 0) AS remaining
           FROM platform_subscription_payments p WHERE p.id = $1`,
          [params.invoiceId]
        )
      ).rows[0];
      if (!left) throw httpError(404, "Invoice not found");
      total = Number(left.remaining);
    }
    return issueCreditNote(client, {
      invoiceId: params.invoiceId,
      kind: params.kind,
      reason: params.reason,
      total,
      issuedBy: params.issuedBy,
    });
  });
  startCreditNoteFollowUp(id, { email: true });
  const note = await getCreditNote(id);
  if (!note) throw new Error("Credit note was not found after it was created");
  return note;
}
