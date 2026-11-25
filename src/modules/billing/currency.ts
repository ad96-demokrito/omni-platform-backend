/**
 * Billing currencies and how a workspace's country maps to one (plan/017).
 * Launch set: INR (India, Razorpay) and USD (everyone else, Stripe). Adding a currency means adding it
 * here, giving it a price row per plan in the admin Plans page, and routing it to a gateway below.
 */

export const SUPPORTED_CURRENCIES = ["INR", "USD"] as const;
export type BillingCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const DEFAULT_BILLING_CURRENCY: BillingCurrency = "USD";

export type BillingGateway = "razorpay" | "stripe";

/** Decimal places of the currency's minor unit (paise, cents). Only 2-decimal currencies are supported. */
const CURRENCY_EXPONENT: Record<BillingCurrency, number> = { INR: 2, USD: 2 };

const COUNTRY_CURRENCY: Record<string, BillingCurrency> = { IN: "INR" };

export function isSupportedCurrency(value: unknown): value is BillingCurrency {
  return typeof value === "string" && (SUPPORTED_CURRENCIES as readonly string[]).includes(value.toUpperCase());
}

/** Upper-cases and validates an ISO 3166-1 alpha-2 country code; null when it is not one. */
export function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

export function currencyForCountry(country: string | null | undefined): BillingCurrency {
  return (country && COUNTRY_CURRENCY[country.toUpperCase()]) || DEFAULT_BILLING_CURRENCY;
}

/** Which gateway collects a currency. Decided on the server; the browser never chooses. */
export function gatewayForCurrency(currency: BillingCurrency): BillingGateway {
  return currency === "INR" ? "razorpay" : "stripe";
}

/** Amount in the currency's smallest unit (what Stripe and Razorpay expect). */
export function toMinorUnits(amount: number, currency: BillingCurrency): number {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid amount");
  return Math.round(amount * 10 ** CURRENCY_EXPONENT[currency]);
}
