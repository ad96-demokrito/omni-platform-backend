/**
 * Gapless, per-financial-year document numbers (plan/018).
 *
 * GST rules want invoice numbers that are consecutive, unique within the financial year (1 April - 31 March, India
 * time) and at most 16 characters: `INV/26-27/000123`. A database sequence cannot do that (it skips numbers when a
 * transaction rolls back), so the counter is a row that is incremented inside the SAME transaction that inserts the
 * document: if the insert fails, the increment is undone and the number is handed out again.
 */

export type DocumentType = "invoice" | "credit_note";

const PREFIX: Record<DocumentType, string> = { invoice: "INV", credit_note: "CN" };

const INDIA_TIME_ZONE = "Asia/Kolkata";

/** Calendar parts of an instant as seen in India (IST has no daylight saving). */
function indiaParts(date: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: INDIA_TIME_ZONE, year: "numeric", month: "numeric" })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  return { year: Number(parts.year), month: Number(parts.month) };
}

/** `26-27` for any instant between 1 April 2026 and 31 March 2027 (India time). */
export function financialYearOf(date: Date): string {
  const { year, month } = indiaParts(date);
  const startYear = month >= 4 ? year : year - 1;
  const two = (value: number): string => String(value % 100).padStart(2, "0");
  return `${two(startYear)}-${two(startYear + 1)}`;
}

/** First and last instant (UTC) of a calendar month in India time, for monthly reports: `month` is "YYYY-MM". */
export function indiaMonthRange(month: string): { from: Date; to: Date } | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const from = new Date(Date.UTC(year, monthIndex, 1) - IST_OFFSET_MS);
  const to = new Date(Date.UTC(year, monthIndex + 1, 1) - IST_OFFSET_MS);
  return { from, to };
}

export function formatDocumentNumber(type: DocumentType, financialYear: string, serial: number): string {
  return `${PREFIX[type]}/${financialYear}/${String(serial).padStart(6, "0")}`;
}

/** Anything with a `query` method: a pooled client inside a transaction. */
export interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Hands out the next number. MUST be called with the client of the transaction that inserts the document, and
 * the insert must happen in that same transaction (the counter row stays locked until it commits).
 */
export async function allocateDocumentNumber(
  client: Queryable,
  type: DocumentType,
  issuedAt: Date = new Date()
): Promise<string> {
  const financialYear = financialYearOf(issuedAt);
  const result = await client.query(
    `INSERT INTO invoice_counters (document_type, financial_year, last_number)
     VALUES ($1, $2, 1)
     ON CONFLICT (document_type, financial_year)
     DO UPDATE SET last_number = invoice_counters.last_number + 1
     RETURNING last_number`,
    [type, financialYear]
  );
  const serial = Number(result.rows[0]?.last_number);
  if (!Number.isInteger(serial) || serial < 1) throw new Error("Could not allocate a document number");
  return formatDocumentNumber(type, financialYear, serial);
}
