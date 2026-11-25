import type { CreditNoteRecord, SubscriptionPaymentRecord } from "./payment-record";
import { stateName } from "./gst-states";

/**
 * What an invoice PRINTS, as plain data (plan/018). `buildInvoiceDocument` turns a stored ledger row into this and
 * `invoice-pdf.service` only draws it, so the wording, the tax lines and the amounts can be tested without a PDF.
 * It reads the stored snapshot only: never the live workspace profile or the current seller settings.
 */
export interface InvoiceDocument {
  /** "TAX INVOICE", "INVOICE" (export of services), "CREDIT NOTE" or "RECEIPT" (legacy rows without a tax snapshot). */
  title: string;
  number: string;
  dateText: string;
  /** Lines printed under the number, for example "Against invoice INV/26-27/000123 dated 25 Nov 2026". */
  references: string[];
  seller: string[];
  buyer: string[];
  placeOfSupply: string | null;
  item: { description: string; sac: string | null; period: string; amount: string };
  /** Tax lines under the taxable value, in print order, for example "CGST @ 9%". */
  taxRows: Array<{ label: string; amount: string }>;
  taxableValueText: string;
  totalText: string;
  /** Printed under the total, for example "Less: credit note CN/26-27/000004" then "Amount payable". */
  adjustments: Array<{ label: string; amount: string; bold?: boolean }>;
  totalInWords: string;
  paymentLines: string[];
  notes: string[];
  isLegacy: boolean;
}

const INDIA_TIME_ZONE = "Asia/Kolkata";

export function formatInvoiceDate(value: string | Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: INDIA_TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

export function formatInvoiceMoney(amount: number, currency: string): string {
  const code = currency.trim().toUpperCase();
  try {
    return new Intl.NumberFormat(code === "INR" ? "en-IN" : "en-US", {
      style: "currency",
      currency: code,
      currencyDisplay: "symbol",
    }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
  "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function underThousand(n: number): string {
  const parts: string[] = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} Hundred`);
    n %= 100;
  }
  if (n >= 20) {
    parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : ""));
  } else if (n > 0) {
    parts.push(ONES[n]);
  }
  return parts.join(" ");
}

/** Whole number in words. `indian` uses crore / lakh / thousand, otherwise million / thousand. */
export function wholeNumberInWords(value: number, indian: boolean): string {
  if (value === 0) return "Zero";
  const units: Array<[number, string]> = indian
    ? [[10_000_000, "Crore"], [100_000, "Lakh"], [1_000, "Thousand"]]
    : [[1_000_000_000, "Billion"], [1_000_000, "Million"], [1_000, "Thousand"]];
  const parts: string[] = [];
  let rest = value;
  for (const [size, name] of units) {
    if (rest >= size) {
      parts.push(`${wholeNumberInWords(Math.floor(rest / size), indian)} ${name}`);
      rest %= size;
    }
  }
  if (rest > 0) parts.push(underThousand(rest));
  return parts.join(" ");
}

/** "Rupees One Thousand Seven Hundred Sixty Eight and Eighty Two Paise Only". */
export function amountInWords(amount: number, currency: string): string {
  const code = currency.trim().toUpperCase();
  const minor = Math.round(amount * 100);
  const major = Math.floor(minor / 100);
  const fraction = minor % 100;
  const [majorName, minorName] = code === "INR" ? ["Rupees", "Paise"] : code === "USD" ? ["US Dollars", "Cents"] : [code, "Minor Units"];
  const words = `${majorName} ${wholeNumberInWords(major, code === "INR")}`;
  return `${words}${fraction > 0 ? ` and ${wholeNumberInWords(fraction, false)} ${minorName}` : ""} Only`;
}

const trimRate = (rate: number): string => String(Number(rate.toFixed(2)));

/** A credit note applied to an invoice (an upgrade): shown under the invoice total. */
export interface AppliedCredit {
  creditNoteNumber: string;
  total: number;
}

export function buildInvoiceDocument(payment: SubscriptionPaymentRecord, appliedCredit?: AppliedCredit | null): InvoiceDocument {
  const currency = payment.currency.trim();
  const money = (value: number): string => formatInvoiceMoney(value, currency);
  const isLegacy = payment.supplyType === null;
  const isExport = payment.supplyType === "export";
  const when = payment.issuedAt ?? payment.createdAt;

  const seller = [
    payment.sellerName ?? "Omni Platform",
    payment.sellerAddress ?? "",
    payment.sellerTaxId ? `GSTIN: ${payment.sellerTaxId}${payment.sellerStateCode ? ` (State code ${payment.sellerStateCode})` : ""}` : "",
  ].filter(Boolean);

  const buyerState = payment.buyerStateCode ? stateName(payment.buyerStateCode) : null;
  const buyer = [
    payment.buyerName ?? payment.tenantName,
    payment.buyerAddress ?? "",
    payment.buyerTaxId ? `GSTIN: ${payment.buyerTaxId}` : "",
    buyerState ? `State: ${buyerState} (${payment.buyerStateCode})` : "",
  ].filter(Boolean);

  const taxRows: Array<{ label: string; amount: string }> = [];
  if (payment.taxAmount > 0) {
    const half = trimRate(payment.taxRate / 2);
    if (payment.cgstAmount > 0) taxRows.push({ label: `CGST @ ${half}%`, amount: money(payment.cgstAmount) });
    if (payment.sgstAmount > 0) taxRows.push({ label: `SGST @ ${half}%`, amount: money(payment.sgstAmount) });
    if (payment.igstAmount > 0) taxRows.push({ label: `IGST @ ${trimRate(payment.taxRate)}%`, amount: money(payment.igstAmount) });
    // A legacy row has the total tax but no split: show it as one line.
    if (taxRows.length === 0) taxRows.push({ label: `${payment.taxLabel ?? "Tax"} @ ${trimRate(payment.taxRate)}%`, amount: money(payment.taxAmount) });
  }

  const cycle = payment.billingCycle === "yearly" ? "yearly" : payment.billingCycle === "monthly" ? "monthly" : payment.billingCycle;
  const credit = appliedCredit && appliedCredit.total > 0 ? appliedCredit : null;
  const cashPaid = Math.round((payment.amount - (credit ? credit.total : 0)) * 100) / 100;
  const adjustments: InvoiceDocument["adjustments"] = credit
    ? [
        { label: `Less: credit note ${credit.creditNoteNumber}`, amount: `-${money(credit.total)}` },
        { label: "Amount payable", amount: money(cashPaid), bold: true },
      ]
    : [];
  const paymentLines = [
    `Payment method: ${payment.paymentMethod.toUpperCase()}`,
    payment.transactionReference ? `Payment reference: ${payment.transactionReference}` : "",
    `Amount paid: ${money(cashPaid)}`,
  ].filter(Boolean);

  const notes: string[] = [];
  if (isExport) {
    notes.push(
      payment.lutNumber
        ? `Supply meant for export of services under Letter of Undertaking (LUT) No. ${payment.lutNumber}, without payment of IGST.`
        : "Supply meant for export of services without payment of IGST."
    );
  }
  if (isLegacy) notes.push("This receipt was issued before GST tax invoices were introduced.");
  notes.push("This is a computer-generated document and does not require a signature.");

  return {
    title: isLegacy ? "RECEIPT" : isExport ? "INVOICE" : "TAX INVOICE",
    number: payment.invoiceNumber,
    dateText: formatInvoiceDate(when),
    references: [],
    seller,
    buyer,
    placeOfSupply: payment.placeOfSupply,
    item: {
      description: `${payment.planName} plan, ${cycle} subscription`,
      sac: payment.sacCode,
      period: `${formatInvoiceDate(payment.periodStart)} to ${formatInvoiceDate(payment.periodEnd)}`,
      amount: money(payment.subtotal),
    },
    taxRows,
    taxableValueText: money(payment.subtotal),
    totalText: money(payment.amount),
    adjustments,
    totalInWords: amountInWords(credit ? cashPaid : payment.amount, currency),
    paymentLines,
    notes,
    isLegacy,
  };
}

const CREDIT_REASON_LABEL: Record<CreditNoteRecord["kind"], string> = {
  upgrade_credit: "Unused part of the previous plan, credited on an upgrade",
  refund: "Refund",
  cancellation: "Cancellation",
  correction: "Correction of the invoice",
};

/** The credit note as a printable document. All amounts are shown as a reduction of the original invoice. */
export function buildCreditNoteDocument(note: CreditNoteRecord, invoiceIssuedAt: string | null): InvoiceDocument {
  const currency = note.currency;
  const money = (value: number): string => formatInvoiceMoney(value, currency);
  const base = buildInvoiceDocument(
    {
      id: note.id,
      tenantId: note.tenantId,
      tenantName: note.tenantName,
      planId: "",
      planName: "",
      amount: note.total,
      currency,
      billingCycle: "",
      paymentMethod: "",
      transactionReference: null,
      status: "paid",
      invoiceNumber: note.creditNoteNumber,
      periodStart: note.issuedAt,
      periodEnd: note.issuedAt,
      notes: null,
      recordedByStaffId: null,
      recordedByName: null,
      subtotal: note.subtotal,
      taxAmount: note.taxAmount,
      taxRate: note.taxRate,
      taxLabel: "GST",
      buyerTaxId: note.buyerTaxId,
      sellerTaxId: note.sellerTaxId,
      cgstAmount: note.cgstAmount,
      sgstAmount: note.sgstAmount,
      igstAmount: note.igstAmount,
      supplyType: note.supplyType,
      sellerName: note.sellerName,
      sellerAddress: note.sellerAddress,
      sellerStateCode: note.sellerStateCode,
      buyerName: note.buyerName,
      buyerAddress: note.buyerAddress,
      buyerStateCode: note.buyerStateCode,
      placeOfSupply: note.placeOfSupply,
      sacCode: note.sacCode,
      lutNumber: note.lutNumber,
      issuedAt: note.issuedAt,
      hasPdf: false,
      emailStatus: "none",
      emailedAt: null,
      creditApplied: 0,
      createdAt: note.issuedAt,
    },
    null
  );

  const references = [
    `Against invoice ${note.invoiceNumber}${invoiceIssuedAt ? ` dated ${formatInvoiceDate(invoiceIssuedAt)}` : ""}`,
  ];
  const paymentLines = note.appliedToInvoiceNumber
    ? [`Applied to invoice ${note.appliedToInvoiceNumber}; no payment is due for this amount.`]
    : ["Any refund is paid back through the original payment method."];

  return {
    ...base,
    title: "CREDIT NOTE",
    references,
    item: {
      description: CREDIT_REASON_LABEL[note.kind],
      sac: note.sacCode,
      period: "",
      amount: money(note.subtotal),
    },
    totalInWords: amountInWords(note.total, currency),
    paymentLines,
    notes: [
      `Reason: ${note.reason}`,
      ...base.notes.filter((n) => !/before GST tax invoices/.test(n)),
    ],
    isLegacy: false,
  };
}
