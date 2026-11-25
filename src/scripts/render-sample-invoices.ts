/**
 * Writes four sample PDFs (same-state B2B invoice, other-state B2C invoice, a credit note, USD export invoice) so the accountant can review the
 * layout and wording before go-live (plan/018). Uses made-up customers and your current SELLER_* settings; touches
 * no database, sends no email.
 *
 *   npm run invoice:samples            -> writes to the OS temp folder and prints the paths
 *   npm run invoice:samples -- ./out   -> writes to ./out
 */
import fs from "fs";
import os from "os";
import path from "path";
import { buildCreditNoteDocument, buildInvoiceDocument } from "../modules/billing/invoice-document";
import { renderInvoicePdf } from "../modules/billing/invoice-pdf.service";
import { sellerDetails } from "../modules/billing/config";
import { stateName } from "../modules/billing/gst-states";
import type { SubscriptionPaymentRecord } from "../modules/billing/payment-record";

const seller = sellerDetails();

const base: SubscriptionPaymentRecord = {
  id: "sample",
  tenantId: "sample",
  tenantName: "Sample Customer",
  planId: "starter",
  planName: "Starter Growth",
  amount: 0,
  currency: "INR",
  billingCycle: "monthly",
  paymentMethod: "razorpay",
  transactionReference: "pay_SAMPLE12345",
  status: "paid",
  invoiceNumber: "INV/26-27/000001",
  periodStart: "2026-11-25T04:00:00Z",
  periodEnd: "2026-12-25T04:00:00Z",
  notes: null,
  recordedByStaffId: null,
  recordedByName: null,
  subtotal: 0,
  taxAmount: 0,
  taxRate: 0,
  taxLabel: "GST",
  buyerTaxId: null,
  sellerTaxId: seller.taxId,
  cgstAmount: 0,
  sgstAmount: 0,
  igstAmount: 0,
  supplyType: "b2c",
  sellerName: seller.legalName ?? "Your Company Pvt Ltd",
  sellerAddress: seller.address ?? "Your registered address",
  sellerStateCode: seller.stateCode,
  buyerName: "Sample Customer",
  buyerAddress: null,
  buyerStateCode: null,
  placeOfSupply: null,
  sacCode: seller.sacCode,
  lutNumber: null,
  issuedAt: new Date().toISOString(),
  hasPdf: false,
  emailStatus: "none",
  emailedAt: null,
  creditApplied: 0,
  createdAt: new Date().toISOString(),
};

const samples: Record<string, SubscriptionPaymentRecord> = {
  "same-state-b2b": {
    ...base,
    invoiceNumber: "INV/26-27/000001",
    subtotal: 1499,
    taxAmount: 269.82,
    amount: 1768.82,
    taxRate: 18,
    cgstAmount: 134.91,
    sgstAmount: 134.91,
    supplyType: "b2b",
    buyerName: "Acme Retail Private Limited",
    buyerAddress: "12 MG Road, Mumbai, Maharashtra, 400001, IN",
    buyerStateCode: seller.stateCode ?? "27",
    buyerTaxId: "27AAAAA0000A1Z5",
    placeOfSupply: stateName(seller.stateCode ?? "27"),
  },
  "other-state-b2c": {
    ...base,
    invoiceNumber: "INV/26-27/000002",
    subtotal: 14990,
    taxAmount: 2698.2,
    amount: 17688.2,
    taxRate: 18,
    igstAmount: 2698.2,
    billingCycle: "yearly",
    buyerName: "Ravi Kumar",
    buyerAddress: "Indiranagar, Bengaluru, Karnataka, 560038, IN",
    buyerStateCode: "29",
    placeOfSupply: "Karnataka",
  },
  "credit-note": {
    ...base,
    // A credit note is a negative document: the amounts below are what is credited.
    invoiceNumber: "CN/26-27/000001",
    subtotal: 1000,
    taxAmount: 180,
    amount: 1180,
    taxRate: 18,
    cgstAmount: 90,
    sgstAmount: 90,
    supplyType: "b2b",
    buyerName: "Acme Retail Private Limited",
    buyerAddress: "12 MG Road, Mumbai, Maharashtra, 400001, IN",
    buyerStateCode: seller.stateCode ?? "27",
    buyerTaxId: "27AAAAA0000A1Z5",
    placeOfSupply: stateName(seller.stateCode ?? "27"),
  },
  "usd-export": {
    ...base,
    invoiceNumber: "INV/26-27/000003",
    currency: "USD",
    subtotal: 29,
    amount: 29,
    supplyType: "export",
    paymentMethod: "stripe",
    transactionReference: "pi_SAMPLE",
    buyerName: "Globex LLC",
    buyerAddress: "500 Market St, San Francisco, CA, 94105, US",
    placeOfSupply: "Outside India (US)",
    lutNumber: seller.lutNumber ?? "AD000000000000Z",
  },
};

async function main(): Promise<void> {
  const outDir = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), "invoice-samples-")));
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, record] of Object.entries(samples)) {
    const document =
      name === "credit-note"
        ? buildCreditNoteDocument(
            {
              id: "sample",
              tenantId: "sample",
              tenantName: record.tenantName,
              creditNoteNumber: record.invoiceNumber,
              invoiceId: "sample",
              invoiceNumber: "INV/26-27/000001",
              kind: "upgrade_credit",
              reason: "Upgrade to the Pro Scale plan: unused time of the previous plan",
              currency: record.currency,
              subtotal: record.subtotal,
              taxRate: record.taxRate,
              cgstAmount: record.cgstAmount,
              sgstAmount: record.sgstAmount,
              igstAmount: record.igstAmount,
              taxAmount: record.taxAmount,
              total: record.amount,
              appliedToInvoiceId: "sample2",
              appliedToInvoiceNumber: "INV/26-27/000004",
              sellerName: record.sellerName,
              sellerAddress: record.sellerAddress,
              sellerStateCode: record.sellerStateCode,
              sellerTaxId: record.sellerTaxId,
              buyerName: record.buyerName,
              buyerAddress: record.buyerAddress,
              buyerStateCode: record.buyerStateCode,
              buyerTaxId: record.buyerTaxId,
              placeOfSupply: record.placeOfSupply,
              sacCode: record.sacCode,
              supplyType: record.supplyType,
              lutNumber: null,
              issuedBy: "system",
              issuedAt: record.issuedAt ?? new Date().toISOString(),
              hasPdf: false,
              emailStatus: "none",
              emailedAt: null,
            },
            record.issuedAt
          )
        : buildInvoiceDocument(record);
    const pdf = await renderInvoicePdf(document);
    const file = path.join(outDir, `sample-${name}.pdf`);
    fs.writeFileSync(file, pdf);
    console.log(file);
  }
}

main().catch((err) => {
  console.error("Could not render the sample invoices:", err);
  process.exit(1);
});
