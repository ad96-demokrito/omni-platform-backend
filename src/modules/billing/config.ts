import { logger } from "../../utils/logger";
import { normalizeStateCode, stateCodeFromGstin } from "./gst-states";

/**
 * Billing configuration, read in one place (plan/017). Nothing here has a silent default for anything
 * security-relevant: in production a missing webhook secret or public URL stops the server at startup.
 */

const isProduction = (): boolean => process.env.NODE_ENV === "production";

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function razorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

/** Public URL of the web app, no trailing slash. Where gateways send customers back to. */
export function publicAppUrl(): string {
  return (process.env.PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
}

/** The fake "sandbox" gateway exists only outside production and only when explicitly switched on. */
export function sandboxEnabled(): boolean {
  return process.env.BILLING_SANDBOX === "true" && !isProduction();
}

export function stripeWebhookSecret(): string {
  return process.env.STRIPE_WEBHOOK_SECRET || "";
}

export function razorpayWebhookSecret(): string {
  return process.env.RAZORPAY_WEBHOOK_SECRET || "";
}

/** GST rate in percent charged on INR invoices; 0 turns tax off. */
export function gstRatePercent(): number {
  const raw = process.env.GST_RATE_PERCENT;
  if (raw === undefined || raw.trim() === "") return 18;
  const rate = Number(raw);
  return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate : 18;
}

export interface SellerDetails {
  legalName: string | null;
  taxId: string | null;
  address: string | null;
  /** GST state code of the seller: SELLER_STATE_CODE, otherwise the first two digits of the GSTIN. */
  stateCode: string | null;
  /** Service accounting code printed on every invoice line (ask the CA which one applies). */
  sacCode: string | null;
  /** Letter of Undertaking number printed on export-of-services invoices (USD customers). */
  lutNumber: string | null;
  pan: string | null;
}

const GSTIN_FORMAT = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Who issues the invoice (printed on every invoice and receipt). */
export function sellerDetails(): SellerDetails {
  const taxId = process.env.SELLER_GSTIN?.trim().toUpperCase() || null;
  return {
    legalName: process.env.SELLER_LEGAL_NAME?.trim() || null,
    taxId,
    address: process.env.SELLER_ADDRESS?.trim() || null,
    stateCode: normalizeStateCode(process.env.SELLER_STATE_CODE) ?? stateCodeFromGstin(taxId),
    sacCode: process.env.SELLER_SAC_CODE?.trim() || null,
    lutNumber: process.env.SELLER_LUT_NUMBER?.trim() || null,
    pan: process.env.SELLER_PAN?.trim().toUpperCase() || null,
  };
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return defaultValue;
  return !["false", "0", "off", "no"].includes(raw);
}

/** INVOICE_EMAIL_ENABLED (default true): whether invoices/receipts are emailed at all. PDFs are still created. */
export function invoiceEmailEnabled(): boolean {
  return envFlag("INVOICE_EMAIL_ENABLED", true);
}

/** INVOICE_PDF_ATTACH (default true): attach the PDF to the invoice email. */
export function invoicePdfAttach(): boolean {
  return envFlag("INVOICE_PDF_ATTACH", true);
}

/** INVOICE_BCC_EMAIL: an optional address (the accountant) that gets a copy of every invoice email. */
export function invoiceBccEmail(): string | null {
  const value = process.env.INVOICE_BCC_EMAIL?.trim();
  return value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

/**
 * Called once at startup. In production a configured gateway must come with its webhook secret (an
 * unsigned webhook would let anyone mark a payment as paid) and the app URL customers return to.
 * Returns the problems found; the caller throws in production and only warns elsewhere.
 */
export function findBillingConfigProblems(): string[] {
  const problems: string[] = [];
  if (stripeConfigured() && !stripeWebhookSecret()) {
    problems.push("STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is missing");
  }
  if (razorpayConfigured() && !razorpayWebhookSecret()) {
    problems.push("RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are set but RAZORPAY_WEBHOOK_SECRET is missing");
  }
  if ((stripeConfigured() || razorpayConfigured()) && !publicAppUrl()) {
    problems.push("A payment gateway is configured but PUBLIC_APP_URL is missing");
  }
  if (process.env.BILLING_SANDBOX === "true" && isProduction()) {
    problems.push("BILLING_SANDBOX=true must not be set in production");
  }

  // A GST tax invoice needs the seller's identity. Only matters while GST is switched on.
  if (gstRatePercent() > 0) {
    const seller = sellerDetails();
    const missing: string[] = [];
    if (!seller.taxId) missing.push("SELLER_GSTIN");
    if (!seller.legalName) missing.push("SELLER_LEGAL_NAME");
    if (!seller.address) missing.push("SELLER_ADDRESS");
    if (!seller.sacCode) missing.push("SELLER_SAC_CODE");
    if (missing.length > 0) {
      problems.push(`GST is on (GST_RATE_PERCENT > 0) but invoice seller details are missing: ${missing.join(", ")}`);
    }
    if (seller.taxId && !GSTIN_FORMAT.test(seller.taxId)) {
      problems.push("SELLER_GSTIN is not a valid 15-character GSTIN");
    }
    if (seller.taxId && !seller.stateCode) {
      problems.push("SELLER_GSTIN does not start with a valid GST state code (set SELLER_STATE_CODE)");
    }
  }
  if (process.env.INVOICE_BCC_EMAIL?.trim() && !invoiceBccEmail()) {
    problems.push("INVOICE_BCC_EMAIL is not a valid email address");
  }
  return problems;
}

export function assertBillingConfig(): void {
  const problems = findBillingConfigProblems();
  if (problems.length === 0) return;
  if (isProduction()) {
    throw new Error(`Invalid billing configuration: ${problems.join("; ")}`);
  }
  logger.warn(`[billing] configuration warnings (fatal in production): ${problems.join("; ")}`);
}
