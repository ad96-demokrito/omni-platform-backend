/**
 * One row of the payment ledger (platform_subscription_payments) as the API returns it, and the mapper from
 * the database row. A leaf module on purpose: the ledger, the PDF and the email code all need it and must not
 * import each other in a circle.
 */

export interface SubscriptionPaymentRecord {
  id: string;
  tenantId: string;
  tenantName: string;
  planId: string;
  planName: string;
  amount: number;
  currency: string;
  billingCycle: "monthly" | "yearly" | "custom" | string;
  paymentMethod: "stripe" | "razorpay" | "bank_transfer" | "credit_card" | "manual" | "crypto" | string;
  transactionReference: string | null;
  status: "paid" | "pending" | "failed" | "refunded" | string;
  invoiceNumber: string;
  periodStart: string;
  periodEnd: string;
  notes: string | null;
  recordedByStaffId: string | null;
  recordedByName: string | null;
  /** Before tax. `amount` is the total charged (subtotal + taxAmount). */
  subtotal: number;
  taxAmount: number;
  /** Percent. */
  taxRate: number;
  taxLabel: string | null;
  buyerTaxId: string | null;
  sellerTaxId: string | null;
  /** The tax split (they add up to `taxAmount`). */
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  /** null = a legacy invoice issued before GST tax invoices (no seller/buyer snapshot). */
  supplyType: "b2b" | "b2c" | "export" | null;
  /** Seller and buyer as they were when the invoice was issued. */
  sellerName: string | null;
  sellerAddress: string | null;
  sellerStateCode: string | null;
  buyerName: string | null;
  buyerAddress: string | null;
  buyerStateCode: string | null;
  placeOfSupply: string | null;
  sacCode: string | null;
  lutNumber: string | null;
  issuedAt: string | null;
  /** True once the invoice PDF has been rendered and stored. */
  hasPdf: boolean;
  emailStatus: "none" | "pending" | "sent" | "failed";
  emailedAt: string | null;
  /** Credit applied from a credit note (an upgrade): cash collected = amount - creditApplied. */
  creditApplied: number;
  createdAt: string;
}

/** One ledger row as the API returns it. */
export function mapPaymentRow(r: any, tenantName: string): SubscriptionPaymentRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    tenantName,
    planId: r.plan_id,
    planName: r.plan_name,
    amount: parseFloat(r.amount || "0"),
    currency: r.currency,
    billingCycle: r.billing_cycle,
    paymentMethod: r.payment_method,
    transactionReference: r.transaction_reference,
    status: r.status,
    invoiceNumber: r.invoice_number,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    notes: r.notes,
    recordedByStaffId: r.recorded_by_staff_id,
    recordedByName: r.recorded_by_name,
    subtotal: parseFloat(r.subtotal ?? r.amount ?? "0"),
    taxAmount: parseFloat(r.tax_amount ?? "0"),
    taxRate: parseFloat(r.tax_rate ?? "0"),
    taxLabel: r.tax_label ?? null,
    buyerTaxId: r.buyer_tax_id ?? null,
    sellerTaxId: r.seller_tax_id ?? null,
    cgstAmount: parseFloat(r.cgst_amount ?? "0"),
    sgstAmount: parseFloat(r.sgst_amount ?? "0"),
    igstAmount: parseFloat(r.igst_amount ?? "0"),
    supplyType: r.supply_type ?? null,
    sellerName: r.seller_name ?? null,
    sellerAddress: r.seller_address ?? null,
    sellerStateCode: r.seller_state_code ? String(r.seller_state_code).trim() : null,
    buyerName: r.buyer_name ?? null,
    buyerAddress: r.buyer_address ?? null,
    buyerStateCode: r.buyer_state_code ? String(r.buyer_state_code).trim() : null,
    placeOfSupply: r.place_of_supply ?? null,
    sacCode: r.sac_code ?? null,
    lutNumber: r.lut_number ?? null,
    issuedAt: r.issued_at ?? null,
    hasPdf: Boolean(r.pdf_key),
    emailStatus: r.email_status ?? "none",
    emailedAt: r.emailed_at ?? null,
    creditApplied: parseFloat(r.credit_applied ?? "0"),
    createdAt: r.created_at,
  };
}

/** A credit note (plan/018): reduces an invoice, with its own number, and reverses the tax. */
export interface CreditNoteRecord {
  id: string;
  tenantId: string;
  tenantName: string;
  creditNoteNumber: string;
  invoiceId: string;
  /** The original invoice's number, for display. */
  invoiceNumber: string;
  kind: "upgrade_credit" | "refund" | "cancellation" | "correction";
  reason: string;
  currency: string;
  /** All amounts are positive; the document and the register show them as a reduction. */
  subtotal: number;
  taxRate: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  taxAmount: number;
  total: number;
  appliedToInvoiceId: string | null;
  appliedToInvoiceNumber: string | null;
  sellerName: string | null;
  sellerAddress: string | null;
  sellerStateCode: string | null;
  sellerTaxId: string | null;
  buyerName: string | null;
  buyerAddress: string | null;
  buyerStateCode: string | null;
  buyerTaxId: string | null;
  placeOfSupply: string | null;
  sacCode: string | null;
  supplyType: "b2b" | "b2c" | "export" | null;
  lutNumber: string | null;
  issuedBy: string;
  issuedAt: string;
  hasPdf: boolean;
  emailStatus: "none" | "pending" | "sent" | "failed";
  emailedAt: string | null;
}

export function mapCreditNoteRow(r: any, tenantName: string): CreditNoteRecord {
  const code = (value: unknown): string | null => (value ? String(value).trim() : null);
  return {
    id: r.id,
    tenantId: r.tenant_id,
    tenantName,
    creditNoteNumber: r.credit_note_number,
    invoiceId: r.invoice_id,
    invoiceNumber: r.invoice_number ?? "",
    kind: r.kind,
    reason: r.reason,
    currency: String(r.currency).trim(),
    subtotal: parseFloat(r.subtotal || "0"),
    taxRate: parseFloat(r.tax_rate ?? "0"),
    cgstAmount: parseFloat(r.cgst_amount ?? "0"),
    sgstAmount: parseFloat(r.sgst_amount ?? "0"),
    igstAmount: parseFloat(r.igst_amount ?? "0"),
    taxAmount: parseFloat(r.tax_amount ?? "0"),
    total: parseFloat(r.total || "0"),
    appliedToInvoiceId: r.applied_to_invoice_id ?? null,
    appliedToInvoiceNumber: r.applied_to_invoice_number ?? null,
    sellerName: r.seller_name ?? null,
    sellerAddress: r.seller_address ?? null,
    sellerStateCode: code(r.seller_state_code),
    sellerTaxId: r.seller_tax_id ?? null,
    buyerName: r.buyer_name ?? null,
    buyerAddress: r.buyer_address ?? null,
    buyerStateCode: code(r.buyer_state_code),
    buyerTaxId: r.buyer_tax_id ?? null,
    placeOfSupply: r.place_of_supply ?? null,
    sacCode: r.sac_code ?? null,
    supplyType: r.supply_type ?? null,
    lutNumber: r.lut_number ?? null,
    issuedBy: r.issued_by,
    issuedAt: r.issued_at,
    hasPdf: Boolean(r.pdf_key),
    emailStatus: r.email_status ?? "none",
    emailedAt: r.emailed_at ?? null,
  };
}
