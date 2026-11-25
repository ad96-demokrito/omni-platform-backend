import crypto from "crypto";
import { query, queryOne } from "../../db/pool";
import { logger } from "../../utils/logger";
import { handleRazorpayWebhook as handleCommerceRazorpay, handleStripeWebhook as handleCommerceStripe } from "../commerce/payments.service";
import { confirmCheckoutPayment, findCheckoutByGatewaySession } from "./checkout.service";
import { razorpayWebhookSecret, stripeWebhookSecret } from "./config";
import { verifyRazorpaySignature, verifyStripeSignature } from "./gateways";
import { fromUnix, markEnded, markPastDue, recordRenewal, syncCancelAtPeriodEnd } from "./subscription.service";

/**
 * Entry points for the Stripe and Razorpay webhooks (plan/017, Phase 2).
 *  1. The signature is checked on the raw body. With no secret configured, production refuses every
 *     webhook (an unsigned webhook would let anyone mark a payment as paid); development only warns.
 *  2. Each provider event is recorded once; a redelivery of an event that was fully processed is ignored.
 *  3. The event is routed by looking its session up in OUR billing_checkout_sessions: a match is a plan
 *     purchase, anything else is a commerce order payment (the existing behaviour).
 * Responses: 200 handled/ignored/duplicate, 400 bad signature, 5xx so the provider retries a real failure.
 */

const log = logger.child({ module: "payment-webhooks" });

export interface WebhookResponse {
  status: number;
  json: Record<string, unknown>;
}

type Json = Record<string, any>;

const isProduction = (): boolean => process.env.NODE_ENV === "production";

/** Returns an error response when the request must be rejected, otherwise null. */
function checkSignature(provider: string, secret: string, valid: boolean): WebhookResponse | null {
  if (!secret) {
    if (isProduction()) {
      log.error(`${provider} webhook rejected: no webhook secret is configured`);
      return { status: 503, json: { error: "Webhook endpoint is not configured" } };
    }
    log.warn(`${provider} webhook accepted WITHOUT a signature check (no secret configured; fatal in production)`);
    return null;
  }
  if (!valid) {
    log.warn(`${provider} webhook rejected: invalid signature`);
    return { status: 400, json: { error: "Invalid signature" } };
  }
  return null;
}

/** True when this exact event was already fully processed. A failed earlier attempt may be retried. */
async function isDuplicateEvent(gateway: string, eventId: string, eventType: string | undefined): Promise<boolean> {
  const row = await queryOne<{ processed_at: string | null }>(
    `INSERT INTO payment_webhook_events (gateway, event_id, event_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (gateway, event_id) DO UPDATE SET event_type = EXCLUDED.event_type
     RETURNING processed_at`,
    [gateway, eventId, eventType ?? null]
  );
  return Boolean(row?.processed_at);
}

async function markEventProcessed(gateway: string, eventId: string): Promise<void> {
  await query("UPDATE payment_webhook_events SET processed_at = now() WHERE gateway = $1 AND event_id = $2", [
    gateway,
    eventId,
  ]);
}

async function expireCheckout(checkoutId: string): Promise<void> {
  await query("UPDATE billing_checkout_sessions SET status = 'expired' WHERE id = $1 AND status = 'pending'", [checkoutId]);
}

/** The period an invoice covers: Stripe puts it on the first line item. */
function stripeInvoicePeriod(invoice: Json): { periodStart?: Date; periodEnd?: Date } {
  const period = invoice.lines?.data?.[0]?.period;
  return { periodStart: fromUnix(period?.start), periodEnd: fromUnix(period?.end) };
}

/**
 * A Stripe event about our plans: a plan checkout, or the life of an auto-renewing subscription.
 * Returns false when it is neither (so the commerce order handler gets it).
 */
async function handleStripePlanEvent(event: Json): Promise<boolean> {
  const type: string | undefined = event.type;
  const object: Json = event.data?.object ?? {};

  // --- subscription lifecycle (renewals, failures, cancellation) ---
  if (type === "invoice.paid" || type === "invoice.payment_failed") {
    const subscriptionId: unknown = object.subscription;
    if (typeof subscriptionId !== "string") return false;

    if (type === "invoice.payment_failed") {
      await markPastDue("stripe", subscriptionId);
      return true;
    }
    // The first invoice of a subscription is confirmed through its checkout session, not here.
    if (object.billing_reason === "subscription_create") return true;

    const outcome = await recordRenewal({
      gateway: "stripe",
      gatewaySubscriptionId: subscriptionId,
      paymentId: String(object.id),
      amountMinor: Number(object.amount_paid),
      currency: String(object.currency || "").toUpperCase(),
      ...stripeInvoicePeriod(object),
    });
    if (outcome === "unknown_subscription") log.warn("Stripe renewal for a subscription we do not know", { subscriptionId });
    return true;
  }
  if (type === "customer.subscription.deleted" && typeof object.id === "string") {
    await markEnded("stripe", object.id, "cancelled");
    return true;
  }
  if (type === "customer.subscription.updated" && typeof object.id === "string") {
    await syncCancelAtPeriodEnd("stripe", object.id, object.cancel_at_period_end === true);
    return true;
  }

  // --- a plan checkout ---
  if (typeof object.id !== "string") return false;
  const row = await findCheckoutByGatewaySession("stripe", object.id);
  if (!row) return false;

  if (type === "checkout.session.expired") {
    await expireCheckout(row.id);
    return true;
  }
  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    // A delayed method (bank debit) completes the session before the money arrives: wait for the async event.
    if (object.payment_status !== "paid") return true;
    const isSubscription = row.mode === "subscription";
    await confirmCheckoutPayment(row, {
      // A subscription's first charge is an invoice; its id is the stable id of the payment.
      paymentId: String((isSubscription ? object.invoice || object.subscription : object.payment_intent) || object.id),
      amountMinor: Number(object.amount_total),
      currency: String(object.currency || "").toUpperCase(),
      subscription:
        isSubscription && typeof object.subscription === "string"
          ? { id: object.subscription, customerId: typeof object.customer === "string" ? object.customer : null }
          : undefined,
    });
  }
  return true;
}

export async function handleStripeWebhookRequest(
  rawBody: Buffer | string,
  signature: string | undefined,
  body: Json
): Promise<WebhookResponse> {
  const secret = stripeWebhookSecret();
  const rejected = checkSignature("Stripe", secret, verifyStripeSignature(rawBody, signature, secret));
  if (rejected) return rejected;

  const eventId: unknown = body?.id;
  if (typeof eventId !== "string" || !eventId) return { status: 400, json: { error: "Missing event id" } };

  try {
    if (await isDuplicateEvent("stripe", eventId, body?.type)) return { status: 200, json: { duplicate: true } };
    const handledAsPlan = await handleStripePlanEvent(body);
    const result = handledAsPlan ? { success: true, message: "Plan checkout event processed" } : await handleCommerceStripe(body);
    await markEventProcessed("stripe", eventId);
    return { status: 200, json: { ...result } };
  } catch (err) {
    log.error("Stripe webhook processing failed; the provider will retry", { eventId, reason: (err as Error)?.message });
    return { status: 500, json: { error: "Processing failed" } };
  }
}

/**
 * A Razorpay event about our plans: a payment-link checkout, or the life of an auto-renewing subscription
 * (`subscription.charged` is both the first charge and every renewal). False when it is neither.
 */
async function handleRazorpayPlanEvent(event: Json): Promise<boolean> {
  const type: string | undefined = event.event;

  // --- subscription events ---
  if (typeof type === "string" && type.startsWith("subscription.")) {
    const subscription: Json = event.payload?.subscription?.entity ?? {};
    const subscriptionId: unknown = subscription.id;
    if (typeof subscriptionId !== "string") return false;

    switch (type) {
      case "subscription.charged": {
        const payment: Json = event.payload?.payment?.entity ?? {};
        const evidence = {
          paymentId: String(payment.id || ""),
          amountMinor: Number(payment.amount),
          currency: String(payment.currency || "").toUpperCase(),
          periodStart: fromUnix(subscription.current_start),
          periodEnd: fromUnix(subscription.current_end),
        };
        if (!evidence.paymentId) {
          log.error("Razorpay subscription.charged without a payment id; ignored", { subscriptionId });
          return true;
        }
        // A renewal if we already know the subscription; otherwise this is its FIRST charge, confirmed via its checkout.
        const outcome = await recordRenewal({ gateway: "razorpay", gatewaySubscriptionId: subscriptionId, ...evidence });
        if (outcome === "unknown_subscription") {
          const row = await findCheckoutByGatewaySession("razorpay", subscriptionId);
          if (!row) {
            log.warn("Razorpay charge for a subscription we do not know", { subscriptionId });
            return true;
          }
          await confirmCheckoutPayment(row, {
            paymentId: evidence.paymentId,
            amountMinor: evidence.amountMinor,
            currency: evidence.currency,
            subscription: {
              id: subscriptionId,
              customerId: null,
              periodStart: evidence.periodStart,
              periodEnd: evidence.periodEnd,
            },
          });
        }
        return true;
      }
      // `pending` = a charge failed and is being retried; `halted` = the retries ran out.
      case "subscription.pending":
      case "subscription.halted":
        await markPastDue("razorpay", subscriptionId);
        return true;
      case "subscription.cancelled":
        await markEnded("razorpay", subscriptionId, "cancelled");
        return true;
      case "subscription.completed":
        await markEnded("razorpay", subscriptionId, "expired");
        return true;
      default:
        return true; // authenticated / activated / updated: nothing to do
    }
  }

  // --- a payment-link checkout ---
  const link: Json = event.payload?.payment_link?.entity ?? {};
  if (typeof link.id !== "string") return false;

  const row = await findCheckoutByGatewaySession("razorpay", link.id);
  if (!row) return false;

  if (type === "payment_link.expired" || type === "payment_link.cancelled") {
    await expireCheckout(row.id);
    return true;
  }
  if (type === "payment_link.paid") {
    const payment: Json = event.payload?.payment?.entity ?? {};
    await confirmCheckoutPayment(row, {
      paymentId: String(payment.id || link.id),
      amountMinor: Number(payment.amount ?? link.amount_paid ?? link.amount),
      currency: String(payment.currency || link.currency || "").toUpperCase(),
    });
  }
  return true;
}

export async function handleRazorpayWebhookRequest(
  rawBody: Buffer | string,
  signature: string | undefined,
  eventIdHeader: string | undefined,
  body: Json
): Promise<WebhookResponse> {
  const secret = razorpayWebhookSecret();
  const rejected = checkSignature("Razorpay", secret, verifyRazorpaySignature(rawBody, signature, secret));
  if (rejected) return rejected;

  // Razorpay sends a unique id per event; hash the body as a stable fallback if the header is absent.
  const eventId = eventIdHeader || `body:${crypto.createHash("sha256").update(rawBody).digest("hex")}`;

  try {
    if (await isDuplicateEvent("razorpay", eventId, body?.event)) return { status: 200, json: { duplicate: true } };
    const handledAsPlan = await handleRazorpayPlanEvent(body);
    const result = handledAsPlan ? { success: true, message: "Plan checkout event processed" } : await handleCommerceRazorpay(body);
    await markEventProcessed("razorpay", eventId);
    return { status: 200, json: { ...result } };
  } catch (err) {
    log.error("Razorpay webhook processing failed; the provider will retry", { eventId, reason: (err as Error)?.message });
    return { status: 500, json: { error: "Processing failed" } };
  }
}
