import crypto from "crypto";
import path from "path";
import PDFDocument from "pdfkit";
import { query, queryOne } from "../../db/pool";
import { getInvoiceObject, uploadInvoiceObject } from "../../db/object-storage";
import { logger } from "../../utils/logger";
import { mapCreditNoteRow, mapPaymentRow } from "./payment-record";
import { buildCreditNoteDocument, buildInvoiceDocument, InvoiceDocument } from "./invoice-document";

/**
 * Invoice PDFs (plan/018). A PDF is drawn from the ledger row's stored snapshot, stored once at issue time with its
 * SHA-256, and served from storage afterwards. If storage is unavailable the same PDF is drawn again from the same
 * snapshot, so a download never fails because of a storage outage and never shows anything that is not in the ledger.
 */
const log = logger.child({ module: "invoice-pdf" });

// Works from src/ (ts-node-dev) and dist/ (node): both sit three levels below the backend folder.
const FONT_DIR = path.join(__dirname, "..", "..", "..", "assets", "fonts");
const FONT_REGULAR = path.join(FONT_DIR, "NotoSans-Regular.ttf");
const FONT_BOLD = path.join(FONT_DIR, "NotoSans-Bold.ttf");

const PAGE_MARGIN = 40;
const CONTENT_WIDTH = 595.28 - PAGE_MARGIN * 2;
const GRAY = "#64748b";
const DARK = "#0f172a";
const LINE = "#cbd5e1";

/** Draws the invoice on one A4 page. Pure: the same document always gives the same layout. */
export function renderInvoicePdf(document: InvoiceDocument): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const pdf = new PDFDocument({
      size: "A4",
      margin: PAGE_MARGIN,
      info: { Title: `${document.title} ${document.number}`, Author: document.seller[0] ?? "Omni Platform" },
    });
    const chunks: Buffer[] = [];
    pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    try {
      pdf.registerFont("regular", FONT_REGULAR);
      pdf.registerFont("bold", FONT_BOLD);
      const left = PAGE_MARGIN;
      const right = PAGE_MARGIN + CONTENT_WIDTH;

      // Header: seller on the left, document title on the right
      pdf.font("bold").fontSize(15).fillColor(DARK).text(document.seller[0] ?? "", left, 40, { width: 300 });
      pdf.font("regular").fontSize(9).fillColor(GRAY);
      for (const line of document.seller.slice(1)) pdf.text(line, left, pdf.y + 1, { width: 300 });
      const sellerBottom = pdf.y;

      pdf.font("bold").fontSize(20).fillColor(DARK).text(document.title, 340, 40, { width: right - 340, align: "right" });
      pdf.font("regular").fontSize(9).fillColor(GRAY);
      pdf.text(`No: ${document.number}`, 340, pdf.y + 4, { width: right - 340, align: "right" });
      pdf.text(`Date: ${document.dateText}`, 340, pdf.y + 1, { width: right - 340, align: "right" });
      for (const reference of document.references) {
        pdf.text(reference, 340, pdf.y + 1, { width: right - 340, align: "right" });
      }
      if (document.placeOfSupply) {
        pdf.text(`Place of supply: ${document.placeOfSupply}`, 340, pdf.y + 1, { width: right - 340, align: "right" });
      }

      let y = Math.max(sellerBottom, pdf.y) + 18;
      pdf.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(1).stroke();

      // Bill to
      y += 12;
      pdf.font("bold").fontSize(9).fillColor(GRAY).text("BILL TO", left, y);
      pdf.font("bold").fontSize(11).fillColor(DARK).text(document.buyer[0] ?? "", left, pdf.y + 2, { width: 320 });
      pdf.font("regular").fontSize(9).fillColor(GRAY);
      for (const line of document.buyer.slice(1)) pdf.text(line, left, pdf.y + 1, { width: 320 });

      // Items table
      y = pdf.y + 22;
      const columns = { description: left, sac: left + 250, period: left + 310, amount: left + 430 };
      pdf.rect(left, y, CONTENT_WIDTH, 20).fill("#f1f5f9");
      pdf.font("bold").fontSize(9).fillColor(DARK);
      pdf.text("Description", columns.description + 6, y + 6, { width: 230 });
      pdf.text("SAC", columns.sac, y + 6, { width: 55 });
      pdf.text("Period", columns.period, y + 6, { width: 115 });
      pdf.text("Taxable value", columns.amount, y + 6, { width: right - columns.amount - 6, align: "right" });

      y += 28;
      pdf.font("regular").fontSize(9.5).fillColor(DARK);
      pdf.text(document.item.description, columns.description + 6, y, { width: 230 });
      const descriptionBottom = pdf.y;
      pdf.text(document.item.sac ?? "-", columns.sac, y, { width: 55 });
      pdf.text(document.item.period, columns.period, y, { width: 115 });
      pdf.text(document.item.amount, columns.amount, y, { width: right - columns.amount - 6, align: "right" });
      y = Math.max(descriptionBottom, pdf.y) + 10;
      pdf.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();

      // Totals
      const labelX = left + 280;
      const labelWidth = 130;
      const valueX = left + 420;
      const valueWidth = right - valueX - 6;
      const totalsRow = (label: string, value: string, bold = false) => {
        pdf.font(bold ? "bold" : "regular").fontSize(bold ? 11 : 9.5).fillColor(DARK);
        pdf.text(label, labelX, y, { width: labelWidth, align: "right" });
        pdf.text(value, valueX, y, { width: valueWidth, align: "right" });
        y = pdf.y + 5;
      };
      y += 10;
      totalsRow("Taxable value", document.taxableValueText);
      for (const row of document.taxRows) totalsRow(row.label, row.amount);
      pdf.moveTo(labelX, y).lineTo(right, y).strokeColor(LINE).stroke();
      y += 6;
      totalsRow("Total", document.totalText, true);
      for (const adjustment of document.adjustments) totalsRow(adjustment.label, adjustment.amount, adjustment.bold === true);

      pdf.font("regular").fontSize(9).fillColor(GRAY).text(`Amount in words: ${document.totalInWords}`, left, y + 6, { width: CONTENT_WIDTH });

      // Payment details and notes
      y = pdf.y + 16;
      pdf.font("bold").fontSize(9).fillColor(GRAY).text("PAYMENT", left, y);
      pdf.font("regular").fontSize(9).fillColor(DARK);
      for (const line of document.paymentLines) pdf.text(line, left, pdf.y + 1, { width: CONTENT_WIDTH });
      pdf.moveDown(1);
      pdf.font("regular").fontSize(8.5).fillColor(GRAY);
      for (const note of document.notes) pdf.text(note, left, pdf.y + 2, { width: CONTENT_WIDTH });

      pdf.end();
    } catch (err) {
      reject(err);
    }
  });
}

/** The two documents that have a PDF. Credit notes are stored next to the invoices they reduce. */
export type PdfDocumentKind = "invoice" | "credit_note";

const KIND: Record<PdfDocumentKind, { table: string; numberColumn: string; folder: string }> = {
  invoice: { table: "platform_subscription_payments", numberColumn: "invoice_number", folder: "invoices" },
  credit_note: { table: "billing_credit_notes", numberColumn: "credit_note_number", folder: "credit-notes" },
};

export const invoiceStorageKey = (tenantId: string, documentNumber: string, kind: PdfDocumentKind = "invoice"): string =>
  `invoices/${tenantId}/${kind === "credit_note" ? "credit-notes/" : ""}${documentNumber.replace(/[^A-Za-z0-9-]+/g, "-")}.pdf`;

/** A safe download name such as `INV-26-27-000123.pdf` or `CN-26-27-000001.pdf`. */
export const invoiceDownloadName = (documentNumber: string): string =>
  `${documentNumber.replace(/[^A-Za-z0-9-]+/g, "-")}.pdf`;

interface DocumentRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  amount?: string;
  total?: string;
  tenant_name: string;
  pdf_key: string | null;
  pdf_sha256: string | null;
}

const numberOf = (kind: PdfDocumentKind, row: DocumentRow): string => String(row[KIND[kind].numberColumn]);

async function loadRow(kind: PdfDocumentKind, id: string, tenantId?: string): Promise<DocumentRow | null> {
  const { table } = KIND[kind];
  const extra =
    kind === "invoice"
      ? ""
      : `, (SELECT invoice_number FROM platform_subscription_payments WHERE id = d.invoice_id) AS invoice_number,
         (SELECT invoice_number FROM platform_subscription_payments WHERE id = d.applied_to_invoice_id) AS applied_to_invoice_number`;
  const row = await queryOne<DocumentRow>(
    `SELECT d.*, t.name AS tenant_name${extra}
     FROM ${table} d
     JOIN tenants t ON t.id = d.tenant_id
     WHERE d.id = $1 ${tenantId ? "AND d.tenant_id = $2" : ""}`,
    tenantId ? [id, tenantId] : [id]
  );
  return row ?? null;
}

const sha256 = (data: Buffer): string => crypto.createHash("sha256").update(data).digest("hex");

/** Draws the PDF of a stored document from its snapshot. */
async function drawFromRow(kind: PdfDocumentKind, row: DocumentRow): Promise<Buffer> {
  if (kind === "credit_note") {
    const note = mapCreditNoteRow(row, row.tenant_name);
    const invoice = await queryOne<{ issued_at: string | null }>(
      "SELECT issued_at FROM platform_subscription_payments WHERE id = $1",
      [note.invoiceId]
    );
    return renderInvoicePdf(buildCreditNoteDocument(note, invoice?.issued_at ?? null));
  }
  const record = mapPaymentRow(row, row.tenant_name);
  const credit = await queryOne<{ credit_note_number: string; total: string }>(
    `SELECT credit_note_number, total FROM billing_credit_notes
     WHERE applied_to_invoice_id = $1 ORDER BY issued_at LIMIT 1`,
    [row.id]
  );
  return renderInvoicePdf(
    buildInvoiceDocument(record, credit ? { creditNoteNumber: credit.credit_note_number, total: Number(credit.total) } : null)
  );
}

/** Stores a freshly drawn PDF once. The WHERE clause keeps an already stored PDF from ever being replaced. */
async function storeIfMissing(kind: PdfDocumentKind, row: DocumentRow, pdf: Buffer): Promise<boolean> {
  const key = invoiceStorageKey(row.tenant_id, numberOf(kind, row), kind);
  try {
    await uploadInvoiceObject({ key, body: pdf });
    const updated = await query(
      `UPDATE ${KIND[kind].table} SET pdf_key = $2, pdf_sha256 = $3 WHERE id = $1 AND pdf_key IS NULL RETURNING id`,
      [row.id, key, sha256(pdf)]
    );
    return updated.length > 0;
  } catch (err) {
    log.warn("PDF could not be stored (it is drawn again on demand)", {
      kind,
      documentId: row.id,
      reason: (err as Error)?.message,
    });
    return false;
  }
}

export interface PdfResult {
  pdf: Buffer;
  fileName: string;
  documentNumber: string;
}

/**
 * The PDF of an invoice or credit note: the stored file when there is one, otherwise drawn from the snapshot (and
 * stored for next time). Pass `tenantId` for tenant requests: another workspace's document is then "not found".
 */
export async function getDocumentPdf(kind: PdfDocumentKind, id: string, tenantId?: string): Promise<PdfResult | null> {
  const row = await loadRow(kind, id, tenantId);
  // A zero-amount record (free plan) is not an invoice, so there is nothing to download.
  if (!row || Number(kind === "invoice" ? row.amount : row.total) <= 0) return null;
  const documentNumber = numberOf(kind, row);
  const fileName = invoiceDownloadName(documentNumber);

  if (row.pdf_key) {
    try {
      const stored = await getInvoiceObject(row.pdf_key);
      if (row.pdf_sha256 && sha256(stored) !== row.pdf_sha256) {
        log.error("stored PDF does not match its recorded hash", { kind, documentId: row.id });
      }
      return { pdf: stored, fileName, documentNumber };
    } catch (err) {
      log.warn("stored PDF could not be read, drawing it again from the ledger", {
        kind,
        documentId: row.id,
        reason: (err as Error)?.message,
      });
    }
    return { pdf: await drawFromRow(kind, row), fileName, documentNumber };
  }

  const pdf = await drawFromRow(kind, row);
  await storeIfMissing(kind, row, pdf);
  return { pdf, fileName, documentNumber };
}

/** The invoice PDF of a ledger row (see `getDocumentPdf`). */
export async function getInvoicePdf(
  paymentId: string,
  tenantId?: string
): Promise<{ pdf: Buffer; fileName: string; invoiceNumber: string } | null> {
  const result = await getDocumentPdf("invoice", paymentId, tenantId);
  return result ? { pdf: result.pdf, fileName: result.fileName, invoiceNumber: result.documentNumber } : null;
}

/** Called right after a document was issued: draws and stores its PDF. Never throws. */
export async function issueDocumentPdf(kind: PdfDocumentKind, id: string): Promise<void> {
  try {
    await getDocumentPdf(kind, id);
  } catch (err) {
    log.error("could not create the PDF", { kind, documentId: id, reason: (err as Error)?.message });
  }
}

export const issueInvoicePdf = (paymentId: string): Promise<void> => issueDocumentPdf("invoice", paymentId);
