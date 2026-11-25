import { strToU8, zipSync, Zippable } from "fflate";
import { query } from "../../db/pool";
import { httpError } from "../../utils/http-error";
import { sellerDetails } from "./config";
import { indiaMonthRange } from "./invoice-number";
import { getDocumentPdf, invoiceDownloadName } from "./invoice-pdf.service";

/**
 * The monthly package for the accountant (plan/018): one ZIP with the GST sales register, a tax summary, a gateway
 * reconciliation sheet and every invoice PDF of the month. Months are calendar months in India time (IST), judged by
 * the invoice's issue date. Currencies are never added together.
 */
const MAX_DOCUMENTS = 3000;

export interface RegisterRow {
  /** The ledger row id: used to fetch the PDF, never printed. */
  ledgerId: string;
  documentNumber: string;
  documentType: "Invoice" | "Credit note";
  /** YYYY-MM-DD in India time. */
  date: string;
  customer: string;
  customerGstin: string;
  supplyType: "B2B" | "B2C" | "Export";
  placeOfSupply: string;
  stateCode: string;
  sacCode: string;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  totalTax: number;
  documentValue: number;
  taxRate: number;
  currency: string;
  gateway: string;
  paymentReference: string;
  originalInvoice: string;
  /** Cash that moved through the gateway for this document (an invoice net of upgrade credit; a refund is negative). */
  cashAmount: number;
  /** Credit notes only: an upgrade credit is applied to the next invoice and moves no cash. */
  appliedToInvoice: boolean;
}

const istDate = (value: Date | string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(value));

const money = (value: number): string => (Math.round(value * 100) / 100).toFixed(2);

/**
 * One CSV cell. Text that starts with = + - @ (or a tab/CR) would be run as a formula by Excel, and customer names are
 * typed by customers, so it is defused with a leading apostrophe. Numbers are written by us and never touched.
 */
export function csvText(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsv(header: string[], rows: Array<Array<string | number>>): string {
  const lines = [header.map(csvText).join(",")];
  for (const row of rows) {
    lines.push(row.map((cell) => (typeof cell === "number" ? money(cell) : csvText(cell))).join(","));
  }
  // A leading BOM makes Excel read the file as UTF-8 (customer names with accents or non-Latin letters).
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function buildRegisterCsv(rows: RegisterRow[]): string {
  return toCsv(
    ["Document no", "Type", "Date", "Customer", "Customer GSTIN", "Supply type", "Place of supply", "State code",
      "SAC", "Taxable value", "CGST", "SGST", "IGST", "Total tax", "Document value", "Tax rate %", "Currency",
      "Gateway", "Payment reference", "Original invoice"],
    rows.map((r) => [r.documentNumber, r.documentType, r.date, r.customer, r.customerGstin, r.supplyType,
      r.placeOfSupply, r.stateCode, r.sacCode, r.taxableValue, r.cgst, r.sgst, r.igst, r.totalTax, r.documentValue,
      r.taxRate, r.currency, r.gateway, r.paymentReference, r.originalInvoice])
  );
}

/** Totals per currency, supply type and tax rate. One row per combination; nothing is summed across currencies. */
export function buildTaxSummaryCsv(rows: RegisterRow[]): string {
  const groups = new Map<string, { count: number; taxable: number; cgst: number; sgst: number; igst: number; tax: number; value: number; key: string[] }>();
  for (const r of rows) {
    const key = [r.currency, r.supplyType, String(r.taxRate)];
    const id = key.join("|");
    const g = groups.get(id) ?? { count: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0, value: 0, key };
    g.count += 1;
    g.taxable += r.taxableValue;
    g.cgst += r.cgst;
    g.sgst += r.sgst;
    g.igst += r.igst;
    g.tax += r.totalTax;
    g.value += r.documentValue;
    groups.set(id, g);
  }
  const sorted = [...groups.values()].sort((a, b) => a.key.join("|").localeCompare(b.key.join("|")));
  return toCsv(
    ["Currency", "Supply type", "Tax rate %", "Documents", "Taxable value", "CGST", "SGST", "IGST", "Total tax", "Document value"],
    sorted.map((g) => [g.key[0], g.key[1], Number(g.key[2]), String(g.count), g.taxable, g.cgst, g.sgst, g.igst, g.tax, g.value])
  );
}

/**
 * What each payment gateway actually moved, with the document it belongs to, to tie against Razorpay / Stripe
 * settlement reports. An invoice shows the cash collected (after any upgrade credit); a refund is negative; the
 * credit note of an upgrade is left out because it is applied to the next invoice and moves no cash.
 */
export function buildReconciliationCsv(rows: RegisterRow[]): string {
  return toCsv(
    ["Date", "Gateway", "Payment id", "Cash amount", "Currency", "Document no", "Type", "Customer"],
    rows
      .filter((r) => !r.appliedToInvoice)
      .map((r) => [r.date, r.gateway, r.paymentReference, r.cashAmount, r.currency, r.documentNumber, r.documentType, r.customer])
  );
}

interface LedgerExportRow {
  id: string;
  invoice_number: string;
  issued_at: string;
  tenant_name: string;
  buyer_name: string | null;
  buyer_tax_id: string | null;
  supply_type: "b2b" | "b2c" | "export";
  place_of_supply: string | null;
  buyer_state_code: string | null;
  sac_code: string | null;
  subtotal: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
  tax_amount: string;
  tax_rate: string;
  amount: string;
  currency: string;
  gateway: string | null;
  payment_method: string;
  gateway_payment_id: string | null;
  transaction_reference: string | null;
  credit_applied: string;
}

interface CreditNoteExportRow {
  id: string;
  credit_note_number: string;
  invoice_number: string;
  kind: string;
  issued_at: string;
  tenant_name: string;
  buyer_name: string | null;
  buyer_tax_id: string | null;
  supply_type: "b2b" | "b2c" | "export";
  place_of_supply: string | null;
  buyer_state_code: string | null;
  sac_code: string | null;
  subtotal: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
  tax_amount: string;
  tax_rate: string;
  total: string;
  currency: string;
  applied_to_invoice_id: string | null;
  gateway: string | null;
  payment_method: string;
  gateway_payment_id: string | null;
}

/** All tax invoices and credit notes issued in the month (India time), oldest first. Credit notes are negative. */
export async function loadMonthlyRegister(month: string): Promise<RegisterRow[]> {
  const range = indiaMonthRange(month);
  if (!range) throw httpError(400, "month must look like 2026-11");

  const rows = await query<LedgerExportRow>(
    `SELECT psp.id, psp.invoice_number, psp.issued_at, t.name AS tenant_name, psp.buyer_name, psp.buyer_tax_id,
            psp.supply_type, psp.place_of_supply, psp.buyer_state_code, psp.sac_code, psp.subtotal, psp.cgst_amount,
            psp.sgst_amount, psp.igst_amount, psp.tax_amount, psp.tax_rate, psp.amount, psp.currency, psp.gateway,
            psp.payment_method, psp.gateway_payment_id, psp.transaction_reference, psp.credit_applied
     FROM platform_subscription_payments psp
     JOIN tenants t ON t.id = psp.tenant_id
     WHERE psp.supply_type IS NOT NULL
       AND psp.amount > 0
       AND psp.status IN ('paid', 'refunded')
       AND psp.issued_at >= $1 AND psp.issued_at < $2
     ORDER BY psp.issued_at, psp.invoice_number
     LIMIT $3`,
    [range.from.toISOString(), range.to.toISOString(), MAX_DOCUMENTS + 1]
  );
  const notes = await query<CreditNoteExportRow>(
    `SELECT cn.id, cn.credit_note_number, inv.invoice_number, cn.kind, cn.issued_at, t.name AS tenant_name,
            cn.buyer_name, cn.buyer_tax_id, cn.supply_type, cn.place_of_supply, cn.buyer_state_code, cn.sac_code,
            cn.subtotal, cn.cgst_amount, cn.sgst_amount, cn.igst_amount, cn.tax_amount, cn.tax_rate, cn.total,
            cn.currency, cn.applied_to_invoice_id, inv.gateway, inv.payment_method, inv.gateway_payment_id
     FROM billing_credit_notes cn
     JOIN tenants t ON t.id = cn.tenant_id
     JOIN platform_subscription_payments inv ON inv.id = cn.invoice_id
     WHERE cn.issued_at >= $1 AND cn.issued_at < $2
     ORDER BY cn.issued_at, cn.credit_note_number
     LIMIT $3`,
    [range.from.toISOString(), range.to.toISOString(), MAX_DOCUMENTS + 1]
  );
  if (rows.length + notes.length > MAX_DOCUMENTS) {
    throw httpError(400, `This month has more than ${MAX_DOCUMENTS} documents. Ask engineering for a split export.`);
  }

  const supplyLabel = { b2b: "B2B", b2c: "B2C", export: "Export" } as const;
  const invoiceRows: RegisterRow[] = rows.map((r) => ({
    ledgerId: r.id,
    documentNumber: r.invoice_number,
    documentType: "Invoice",
    date: istDate(r.issued_at),
    customer: r.buyer_name ?? r.tenant_name,
    customerGstin: r.buyer_tax_id ?? "",
    supplyType: supplyLabel[r.supply_type],
    placeOfSupply: r.place_of_supply ?? "",
    stateCode: r.buyer_state_code ? r.buyer_state_code.trim() : "",
    sacCode: r.sac_code ?? "",
    taxableValue: Number(r.subtotal),
    cgst: Number(r.cgst_amount),
    sgst: Number(r.sgst_amount),
    igst: Number(r.igst_amount),
    totalTax: Number(r.tax_amount),
    documentValue: Number(r.amount),
    taxRate: Number(r.tax_rate),
    currency: r.currency.trim(),
    gateway: r.gateway ?? r.payment_method,
    paymentReference: r.gateway_payment_id ?? r.transaction_reference ?? "",
    originalInvoice: "",
    cashAmount: Math.round((Number(r.amount) - Number(r.credit_applied)) * 100) / 100,
    appliedToInvoice: false,
  }));

  const creditRows: RegisterRow[] = notes.map((n) => ({
    ledgerId: n.id,
    documentNumber: n.credit_note_number,
    documentType: "Credit note",
    date: istDate(n.issued_at),
    customer: n.buyer_name ?? n.tenant_name,
    customerGstin: n.buyer_tax_id ?? "",
    supplyType: supplyLabel[n.supply_type],
    placeOfSupply: n.place_of_supply ?? "",
    stateCode: n.buyer_state_code ? n.buyer_state_code.trim() : "",
    sacCode: n.sac_code ?? "",
    taxableValue: -Number(n.subtotal),
    cgst: -Number(n.cgst_amount),
    sgst: -Number(n.sgst_amount),
    igst: -Number(n.igst_amount),
    totalTax: -Number(n.tax_amount),
    documentValue: -Number(n.total),
    taxRate: Number(n.tax_rate),
    currency: n.currency.trim(),
    gateway: n.gateway ?? n.payment_method,
    paymentReference: n.gateway_payment_id ?? "",
    originalInvoice: n.invoice_number,
    cashAmount: n.applied_to_invoice_id ? 0 : -Number(n.total),
    appliedToInvoice: n.applied_to_invoice_id !== null,
  }));

  return [...invoiceRows, ...creditRows].sort(
    (a, b) => a.date.localeCompare(b.date) || a.documentNumber.localeCompare(b.documentNumber)
  );
}

export interface MonthlyPackage {
  fileName: string;
  zip: Uint8Array;
  documents: number;
  /** Documents whose PDF could not be produced (also listed inside the ZIP). */
  missingPdfs: string[];
}

const readme = (month: string, count: number): string => {
  const seller = sellerDetails();
  return [
    `GST package for ${month} (India time, 1st to last day of the month)`,
    `Seller: ${seller.legalName ?? "-"}  GSTIN: ${seller.taxId ?? "-"}`,
    `Generated: ${new Date().toISOString()}   Documents: ${count}`,
    "",
    `gst-register-${month}.csv        every tax invoice and credit note issued in the month (one row each); credit notes are negative`,
    `tax-summary-${month}.csv         totals per currency, supply type and tax rate (currencies are never added together)`,
    `gateway-reconciliation-${month}.csv   cash collected per invoice (after upgrade credit) and refunds, to match Razorpay / Stripe settlement reports`,
    "invoices/ and credit-notes/     the PDFs exactly as issued to the customers",
    "",
    "Notes: invoices are listed by issue date in India time. Amounts are in the currency of the invoice. Export",
    "invoices (customers outside India) carry no GST. Please ask your CA to review before filing.",
    "",
  ].join("\r\n");
};

/** The whole package, in memory (bounded by MAX_DOCUMENTS; PDFs are about 20 KB each). */
export async function buildMonthlyPackage(month: string): Promise<MonthlyPackage> {
  const register = await loadMonthlyRegister(month);
  const files: Zippable = {
    "README.txt": strToU8(readme(month, register.length)),
    [`gst-register-${month}.csv`]: strToU8(buildRegisterCsv(register)),
    [`tax-summary-${month}.csv`]: strToU8(buildTaxSummaryCsv(register)),
    [`gateway-reconciliation-${month}.csv`]: strToU8(buildReconciliationCsv(register)),
  };

  const missingPdfs: string[] = [];
  for (const row of register) {
    try {
      const document = await getDocumentPdf(row.documentType === "Credit note" ? "credit_note" : "invoice", row.ledgerId);
      if (!document) throw new Error("no PDF");
      // PDFs are already compressed inside: storing them avoids pointless work.
      const folder = row.documentType === "Credit note" ? "credit-notes" : "invoices";
      files[`${folder}/${invoiceDownloadName(row.documentNumber)}`] = [new Uint8Array(document.pdf), { level: 0 }];
    } catch {
      missingPdfs.push(row.documentNumber);
    }
  }
  if (missingPdfs.length > 0) {
    files["MISSING-PDFS.txt"] = strToU8(
      `These invoices are in the register but their PDF could not be produced. Download them from the admin Payments page.\r\n${missingPdfs.join("\r\n")}\r\n`
    );
  }

  return { fileName: `gst-package-${month}.zip`, zip: zipSync(files), documents: register.length, missingPdfs };
}
