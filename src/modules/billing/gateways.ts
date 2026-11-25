import crypto from "crypto";
import { logger } from "../../utils/logger";
import { httpError } from "../../utils/http-error";

/**
 * Thin, mockable wrappers around the two payment providers (plan/017). Every call has a timeout, a
 * provider failure becomes a 502 with a safe message (details go to the server log only), and nothing
 * here knows about tenants or plans.
 */

const log = logger.child({ module: "billing-gateways" });

const REQUEST_TIMEOUT_MS = 15_000;
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;
const PROVIDER_UNAVAILABLE = "The payment provider is not responding. Please try again in a moment.";

type Json = Record<string, unknown>;

interface GatewayResponse {
  ok: boolean;
  status: number;
  json: Json;
}

async function gatewayFetch(url: string, init: RequestInit): Promise<GatewayResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let json: Json = {};
    try {
      const parsed: unknown = await response.json();
      if (typeof parsed === "object" && parsed !== null) json = parsed as Json;
    } catch {
      // A non-JSON body is treated as an empty object; the status code still tells us what happened.
    }
    return { ok: response.ok, status: response.status, json };
  } catch (err) {
    log.error("payment provider request failed", { url: new URL(url).host, reason: (err as Error)?.message });
    throw httpError(502, PROVIDER_UNAVAILABLE, { expose: true });
  } finally {
    clearTimeout(timer);
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function failFromProvider(provider: string, res: GatewayResponse, action: string): never {
  // The provider's error body can name amounts or customers: log the code only, never the body.
  const error = (res.json.error ?? {}) as Json;
  log.error(`${provider} ${action} failed`, { status: res.status, code: str(error.code) ?? str(error.type) });
  throw httpError(502, "The payment provider could not process this request. Please try again or contact support.", {
    expose: true,
  });
}

// ─────────────────────────────── Stripe ───────────────────────────────

function stripeKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw httpError(503, "Card payments are not available right now. Please contact support.", { expose: true });
  return key;
}

export interface CreatedCheckout {
  /** Stripe Checkout Session id (cs_...) or Razorpay payment link id (plink_...). */
  id: string;
  url: string;
}

export async function createStripeCheckout(params: {
  amountMinor: number;
  currency: string;
  productName: string;
  /** Our checkout row id: lets a payment be matched even if only the reference survives. */
  referenceId: string;
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  /** Set to make this a subscription that renews every month/year (the price is defined inline, no Price object). */
  recurringInterval?: "month" | "year";
}): Promise<CreatedCheckout> {
  const body = new URLSearchParams();
  body.append("mode", params.recurringInterval ? "subscription" : "payment");
  body.append("line_items[0][price_data][currency]", params.currency.toLowerCase());
  body.append("line_items[0][price_data][product_data][name]", params.productName);
  body.append("line_items[0][price_data][unit_amount]", String(params.amountMinor));
  if (params.recurringInterval) {
    body.append("line_items[0][price_data][recurring][interval]", params.recurringInterval);
  }
  body.append("line_items[0][quantity]", "1");
  body.append("client_reference_id", params.referenceId);
  for (const [key, value] of Object.entries(params.metadata)) {
    body.append(`metadata[${key}]`, value);
    // Subscription events (renewals) carry the subscription's own metadata, not the session's.
    if (params.recurringInterval) body.append(`subscription_data[metadata][${key}]`, value);
  }
  if (params.customerEmail) body.append("customer_email", params.customerEmail);
  body.append("success_url", params.successUrl);
  body.append("cancel_url", params.cancelUrl);

  const res = await gatewayFetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${stripeKey()}` },
    body: body.toString(),
  });
  const id = str(res.json.id);
  const url = str(res.json.url);
  if (!res.ok || !id || !url) failFromProvider("Stripe", res, "checkout session creation");
  return { id: id as string, url: url as string };
}

export interface GatewayPaymentState {
  paid: boolean;
  /** The provider closed the checkout without payment (expired / cancelled). */
  closed: boolean;
  amountMinor: number | null;
  currency: string | null;
  /** The provider's id for the actual payment (Stripe payment intent / invoice, Razorpay payment). */
  paymentId: string | null;
  /** Present for subscription checkouts: the provider's subscription and the period just paid (unix seconds). */
  subscription?: {
    id: string;
    customerId: string | null;
    periodStart: number | null;
    periodEnd: number | null;
  };
}

export async function fetchStripeCheckout(sessionId: string): Promise<GatewayPaymentState> {
  const res = await gatewayFetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${stripeKey()}` },
  });
  if (!res.ok) failFromProvider("Stripe", res, "checkout session lookup");
  const isSubscription = res.json.mode === "subscription";
  const subscriptionId = str(res.json.subscription);
  return {
    paid: res.json.payment_status === "paid",
    closed: res.json.status === "expired",
    amountMinor: num(res.json.amount_total),
    currency: str(res.json.currency)?.toUpperCase() ?? null,
    // A subscription's first charge is an invoice; that invoice id is the stable id of the payment.
    paymentId: isSubscription ? str(res.json.invoice) : str(res.json.payment_intent),
    subscription:
      isSubscription && subscriptionId
        ? { id: subscriptionId, customerId: str(res.json.customer), periodStart: null, periodEnd: null }
        : undefined,
  };
}

/** Stops a Stripe subscription from renewing; it stays active until the period already paid for ends. */
export async function cancelStripeSubscription(subscriptionId: string): Promise<void> {
  const body = new URLSearchParams({ cancel_at_period_end: "true" });
  const res = await gatewayFetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${stripeKey()}` },
    body: body.toString(),
  });
  if (!res.ok) failFromProvider("Stripe", res, "subscription cancellation");
}

/** Stripe's hosted page where the customer updates their card or sees invoices. */
export async function createStripePortalSession(customerId: string, returnUrl: string): Promise<string> {
  const body = new URLSearchParams({ customer: customerId, return_url: returnUrl });
  const res = await gatewayFetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${stripeKey()}` },
    body: body.toString(),
  });
  const url = str(res.json.url);
  if (!res.ok || !url) failFromProvider("Stripe", res, "billing portal session creation");
  return url as string;
}

// ─────────────────────────────── Razorpay ───────────────────────────────

function razorpayAuth(): string {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) throw httpError(503, "UPI and netbanking payments are not available right now. Please contact support.", {
      expose: true,
    });
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
}

export async function createRazorpayPaymentLink(params: {
  amountMinor: number;
  currency: string;
  description: string;
  referenceId: string;
  notes: Record<string, string>;
  callbackUrl: string;
  customer?: { name?: string; email?: string };
}): Promise<CreatedCheckout> {
  const res = await gatewayFetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: razorpayAuth() },
    body: JSON.stringify({
      amount: params.amountMinor,
      currency: params.currency,
      accept_partial: false,
      description: params.description,
      reference_id: params.referenceId,
      customer: params.customer,
      notify: { sms: false, email: false },
      notes: params.notes,
      callback_url: params.callbackUrl,
      callback_method: "get",
    }),
  });
  const id = str(res.json.id);
  const url = str(res.json.short_url);
  if (!res.ok || !id || !url) failFromProvider("Razorpay", res, "payment link creation");
  return { id: id as string, url: url as string };
}

export async function fetchRazorpayPaymentLink(linkId: string): Promise<GatewayPaymentState> {
  const res = await gatewayFetch(`https://api.razorpay.com/v1/payment_links/${encodeURIComponent(linkId)}`, {
    method: "GET",
    headers: { Authorization: razorpayAuth() },
  });
  if (!res.ok) failFromProvider("Razorpay", res, "payment link lookup");
  const status = str(res.json.status);
  const payments = Array.isArray(res.json.payments) ? (res.json.payments as Json[]) : [];
  const captured = payments.find((p) => p.status === "captured") ?? payments[0];
  return {
    paid: status === "paid",
    closed: status === "expired" || status === "cancelled",
    amountMinor: num(res.json.amount_paid) ?? num(res.json.amount),
    currency: str(res.json.currency)?.toUpperCase() ?? null,
    // Falls back to the link id, which is still unique per payment link.
    paymentId: str(captured?.payment_id) ?? linkId,
  };
}

// ─────────────────────────────── Webhook signatures ───────────────────────────────

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Stripe signs `${timestamp}.${rawBody}` with HMAC-SHA256 and sends `t=<timestamp>,v1=<signature>[,v1=...]`.
 * A timestamp outside the tolerance is rejected so a captured request cannot be replayed later.
 */
export function verifyStripeSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
  nowMs: number = Date.now()
): boolean {
  if (!header || !secret) return false;
  const parts = header.split(",").map((part) => part.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || signatures.length === 0) return false;

  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(nowMs / 1000 - seconds) > STRIPE_SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  return signatures.some((signature) => safeEqual(signature, expected));
}

/** Razorpay sends the hex HMAC-SHA256 of the raw body in `X-Razorpay-Signature`. */
export function verifyRazorpaySignature(rawBody: Buffer | string, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqual(header, expected);
}

// ─────────────────────────────── Razorpay subscriptions ───────────────────────────────

/** A Razorpay "plan" is the recurring price a subscription charges: period + fixed amount (tax already included). */
export async function createRazorpayPlan(params: {
  period: "monthly" | "yearly";
  amountMinor: number;
  currency: string;
  name: string;
  notes: Record<string, string>;
}): Promise<string> {
  const res = await gatewayFetch("https://api.razorpay.com/v1/plans", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: razorpayAuth() },
    body: JSON.stringify({
      period: params.period,
      interval: 1,
      item: { name: params.name, amount: params.amountMinor, currency: params.currency },
      notes: params.notes,
    }),
  });
  const id = str(res.json.id);
  if (!res.ok || !id) failFromProvider("Razorpay", res, "plan creation");
  return id as string;
}

/** Starts a subscription; the customer authorises it (UPI AutoPay / card e-mandate) on the returned short URL. */
export async function createRazorpaySubscription(params: {
  planId: string;
  /** How many billing cycles Razorpay will charge before the subscription completes. */
  totalCount: number;
  notes: Record<string, string>;
}): Promise<CreatedCheckout> {
  const res = await gatewayFetch("https://api.razorpay.com/v1/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: razorpayAuth() },
    body: JSON.stringify({
      plan_id: params.planId,
      total_count: params.totalCount,
      quantity: 1,
      customer_notify: 1,
      notes: params.notes,
    }),
  });
  const id = str(res.json.id);
  const url = str(res.json.short_url);
  if (!res.ok || !id || !url) failFromProvider("Razorpay", res, "subscription creation");
  return { id: id as string, url: url as string };
}

/** Where a Razorpay subscription stands, including the first paid invoice (the evidence of the payment). */
export async function fetchRazorpaySubscription(subscriptionId: string): Promise<GatewayPaymentState> {
  const res = await gatewayFetch(`https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: "GET",
    headers: { Authorization: razorpayAuth() },
  });
  if (!res.ok) failFromProvider("Razorpay", res, "subscription lookup");

  const status = str(res.json.status);
  const paidCount = num(res.json.paid_count) ?? 0;
  const ended = status === "cancelled" || status === "expired" || status === "completed";

  let invoice: Json | undefined;
  if (paidCount > 0) {
    const inv = await gatewayFetch(
      `https://api.razorpay.com/v1/invoices?subscription_id=${encodeURIComponent(subscriptionId)}`,
      { method: "GET", headers: { Authorization: razorpayAuth() } }
    );
    if (!inv.ok) failFromProvider("Razorpay", inv, "subscription invoice lookup");
    const items = Array.isArray(inv.json.items) ? (inv.json.items as Json[]) : [];
    invoice = items.find((i) => i.status === "paid");
  }

  return {
    paid: paidCount > 0 && !!invoice,
    closed: ended && paidCount === 0,
    amountMinor: num(invoice?.amount_paid) ?? num(invoice?.amount) ?? null,
    currency: str(invoice?.currency)?.toUpperCase() ?? null,
    paymentId: str(invoice?.payment_id),
    subscription: {
      id: subscriptionId,
      customerId: str(res.json.customer_id),
      periodStart: num(res.json.current_start),
      periodEnd: num(res.json.current_end),
    },
  };
}

/** Stops renewals at the end of the current paid cycle. */
export async function cancelRazorpaySubscription(subscriptionId: string): Promise<void> {
  const res = await gatewayFetch(
    `https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: razorpayAuth() },
      body: JSON.stringify({ cancel_at_cycle_end: 1 }),
    }
  );
  if (!res.ok) failFromProvider("Razorpay", res, "subscription cancellation");
}
