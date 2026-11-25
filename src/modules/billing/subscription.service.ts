import type { PoolClient } from "pg";
import { v4 as uuidv4 } from "uuid";
import { query, queryOne, withTransaction } from "../../db/pool";
import { AuditService } from "../audit/audit.service";
import { emailService } from "../email/email.service";
import { getPlatformPlanById } from "../platform-governance/platform-plans.service";
import { recordSubscriptionPayment } from "../platform-governance/platform-subscriptions.service";
import { logger } from "../../utils/logger";
import { httpError, isUuid } from "../../utils/http-error";
import { publicAppUrl, sandboxEnabled, sellerDetails } from "./config";
import { BillingCurrency, toMinorUnits } from "./currency";
import { cancelRazorpaySubscription, cancelStripeSubscription, createStripePortalSession } from "./gateways";

/**
 * Auto-renewing subscriptions (plan/017, Phase 3). A subscription row exists only once its FIRST payment was
 * confirmed (by checkout.service). From then on the provider charges every cycle and tells us by webhook; each
 * renewal is checked against the price locked at signup, recorded once, and extends the workspace's plan.
 */

const log = logger.child({ module: "billing-subscriptions" });

export type SubscriptionGateway = "stripe" | "razorpay" | "sandbox";
export type SubscriptionStatus = "active" | "past_due" | "cancelled" | "expired";

export interface SubscriptionRow {
  id: string;
  tenant_id: string;
  checkout_id: string | null;
  gateway: SubscriptionGateway;
  gateway_subscription_id: string;
  gateway_customer_id: string | null;
  plan_id: string;
  billing_cycle: "monthly" | "yearly";
  currency: string;
  subtotal: string;
  tax_amount: string;
  tax_rate: string;
  total: string;
  buyer_tax_id: string | null;
  status: SubscriptionStatus;
  cancel_at_period_end: boolean;
  current_period_start: Date | null;
  current_period_end: Date | null;
  last_payment_at: Date | null;
  cancelled_at: Date | null;
  superseded_at: Date | null;
}

export interface SubscriptionSummary {
  id: string;
  status: SubscriptionStatus;
  planId: string;
  planName: string;
  billingCycle: "monthly" | "yearly";
  currency: string;
  /** What each renewal charges (tax included). */
  amount: number;
  subtotal: number;
  taxAmount: number;
  taxRate: number;
  gateway: SubscriptionGateway;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  /** The customer cancelled: nothing renews, the plan stays active until `currentPeriodEnd`. */
  cancelAtPeriodEnd: boolean;
  /** Stripe subscriptions can open a hosted page to change the card. */
  canManageCard: boolean;
}

const num = (value: string | number): number => (typeof value === "number" ? value : parseFloat(value || "0"));

function addCycle(from: Date, cycle: "monthly" | "yearly"): Date {
  const next = new Date(from);
  if (cycle === "yearly") next.setFullYear(next.getFullYear() + 1);
  else next.setMonth(next.getMonth() + 1);
  return next;
}

const fromUnix = (seconds: number | null | undefined): Date | undefined =>
  typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000) : undefined;
export { fromUnix };

async function toSummary(row: SubscriptionRow): Promise<SubscriptionSummary> {
  const plan = await getPlatformPlanById(row.plan_id);
  return {
    id: row.id,
    status: row.status,
    planId: row.plan_id,
    planName: plan?.name ?? row.plan_id,
    billingCycle: row.billing_cycle,
    currency: row.currency.trim(),
    amount: num(row.total),
    subtotal: num(row.subtotal),
    taxAmount: num(row.tax_amount),
    taxRate: num(row.tax_rate),
    gateway: row.gateway,
    currentPeriodStart: row.current_period_start ? new Date(row.current_period_start).toISOString() : null,
    currentPeriodEnd: row.current_period_end ? new Date(row.current_period_end).toISOString() : null,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    canManageCard: row.gateway === "stripe",
  };
}

/** The workspace's subscription that is renewing (or failing to), if any. */
export async function findLiveSubscription(tenantId: string): Promise<SubscriptionRow | null> {
  return queryOne<SubscriptionRow>(
    "SELECT * FROM tenant_subscriptions WHERE tenant_id = $1 AND status IN ('active', 'past_due') ORDER BY created_at DESC LIMIT 1",
    [tenantId]
  );
}

export async function getSubscriptionSummary(tenantId: string): Promise<SubscriptionSummary | null> {
  const row = await findLiveSubscription(tenantId);
  return row ? toSummary(row) : null;
}

async function ownerEmail(tenantId: string): Promise<{ email: string; tenantName: string } | null> {
  return queryOne<{ email: string; tenantName: string }>(
    `SELECT u.email, t.name AS "tenantName"
     FROM users u JOIN tenants t ON t.id = u.tenant_id
     WHERE u.tenant_id = $1 AND u.role = 'owner' ORDER BY u.created_at LIMIT 1`,
    [tenantId]
  );
}

/**
 * Creates the subscription row for a checkout whose first payment was just confirmed. Runs inside the caller's
 * transaction (checkout.service.confirmCheckoutPayment).
 */
export async function createSubscriptionFromCheckout(
  client: PoolClient,
  checkout: {
    id: string;
    tenant_id: string;
    gateway: SubscriptionGateway;
    plan_id: string;
    billing_cycle: "monthly" | "yearly";
    currency: string;
    subtotal: string;
    tax_amount: string;
    tax_rate: string;
    total: string;
    buyer_tax_id: string | null;
  },
  info: { gatewaySubscriptionId: string; customerId: string | null; periodStart?: Date; periodEnd?: Date }
): Promise<void> {
  const periodStart = info.periodStart ?? new Date();
  const periodEnd = info.periodEnd ?? addCycle(periodStart, checkout.billing_cycle);

  await client.query(
    `INSERT INTO tenant_subscriptions (
       tenant_id, checkout_id, gateway, gateway_subscription_id, gateway_customer_id, plan_id, billing_cycle, currency,
       subtotal, tax_amount, tax_rate, total, buyer_tax_id, status, current_period_start, current_period_end, last_payment_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'active', $14, $15, now())
     ON CONFLICT (gateway, gateway_subscription_id) DO NOTHING`,
    [
      checkout.tenant_id,
      checkout.id,
      checkout.gateway,
      info.gatewaySubscriptionId,
      info.customerId,
      checkout.plan_id,
      checkout.billing_cycle,
      checkout.currency.trim(),
      checkout.subtotal,
      checkout.tax_amount,
      checkout.tax_rate,
      checkout.total,
      checkout.buyer_tax_id,
      periodStart.toISOString(),
      periodEnd.toISOString(),
    ]
  );

  if (checkout.gateway === "stripe" && info.customerId) {
    await client.query("UPDATE tenants SET stripe_customer_id = $2 WHERE id = $1", [checkout.tenant_id, info.customerId]);
  }
}

export type RenewalOutcome = "renewed" | "duplicate" | "unknown_subscription" | "mismatch" | "superseded";

/**
 * Records one automatic renewal charge reported by the provider. Idempotent (a payment id is recorded once, even
 * if its webhook arrives several times or alongside the first-payment confirmation) and checked against the price
 * locked at signup: a charge for a different amount is logged and NOT applied.
 */
export async function recordRenewal(input: {
  gateway: SubscriptionGateway;
  gatewaySubscriptionId: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  periodStart?: Date;
  periodEnd?: Date;
}): Promise<RenewalOutcome> {
  const outcome = await withTransaction<RenewalOutcome>(async (client) => {
    const sub = (
      await client.query<SubscriptionRow>(
        "SELECT * FROM tenant_subscriptions WHERE gateway = $1 AND gateway_subscription_id = $2 FOR UPDATE",
        [input.gateway, input.gatewaySubscriptionId]
      )
    ).rows[0];
    if (!sub) return "unknown_subscription";
    if (sub.superseded_at) {
      // An upgrade replaced this subscription but cancelling it at the provider has not gone through yet.
      log.error("charged on a subscription that an upgrade replaced; NOT applied, the payment must be refunded", {
        subscriptionId: sub.id,
        paymentId: input.paymentId,
      });
      return "superseded";
    }

    const seen = await client.query(
      "SELECT 1 FROM platform_subscription_payments WHERE gateway = $1 AND gateway_payment_id = $2",
      [input.gateway, input.paymentId]
    );
    if (seen.rowCount) return "duplicate";

    const currency = sub.currency.trim() as BillingCurrency;
    const expectedMinor = toMinorUnits(num(sub.total), currency);
    if (input.currency.toUpperCase() !== currency || input.amountMinor !== expectedMinor) {
      log.error("renewal charge does not match the subscription price; NOT applied", {
        subscriptionId: sub.id,
        expectedMinor,
        chargedMinor: input.amountMinor,
        expectedCurrency: currency,
        chargedCurrency: input.currency,
      });
      return "mismatch";
    }

    const periodStart = input.periodStart ?? sub.current_period_end ?? new Date();
    const periodEnd = input.periodEnd ?? addCycle(new Date(periodStart), sub.billing_cycle);
    const taxAmount = num(sub.tax_amount);

    await recordSubscriptionPayment({
      tenantId: sub.tenant_id,
      planId: sub.plan_id,
      amount: num(sub.total),
      currency,
      billingCycle: sub.billing_cycle,
      paymentMethod: sub.gateway,
      transactionReference: input.paymentId,
      gateway: sub.gateway,
      gatewayPaymentId: input.paymentId,
      periodStart: new Date(periodStart).toISOString(),
      periodEnd: new Date(periodEnd).toISOString(),
      taxAmount,
      taxRate: num(sub.tax_rate),
      taxLabel: taxAmount > 0 ? "GST" : null,
      buyerTaxId: sub.buyer_tax_id,
      sellerTaxId: taxAmount > 0 ? sellerDetails().taxId : null,
      notes: `Automatic renewal via ${sub.gateway.toUpperCase()}`,
      sendReceiptEmail: true,
    });

    await client.query(
      `UPDATE tenant_subscriptions
       SET status = 'active', current_period_start = $2, current_period_end = $3, last_payment_at = now(), updated_at = now()
       WHERE id = $1`,
      [sub.id, new Date(periodStart).toISOString(), new Date(periodEnd).toISOString()]
    );
    return "renewed";
  });

  if (outcome === "renewed") {
    log.info("subscription renewed", { gateway: input.gateway });
  }
  return outcome;
}

/** A renewal charge failed (the provider keeps retrying): flag it and tell the owner. Idempotent. */
export async function markPastDue(gateway: SubscriptionGateway, gatewaySubscriptionId: string): Promise<boolean> {
  const sub = await queryOne<SubscriptionRow>(
    `UPDATE tenant_subscriptions SET status = 'past_due', updated_at = now()
     WHERE gateway = $1 AND gateway_subscription_id = $2 AND status = 'active'
     RETURNING *`,
    [gateway, gatewaySubscriptionId]
  );
  if (!sub) return false;

  const owner = await ownerEmail(sub.tenant_id);
  const plan = await getPlatformPlanById(sub.plan_id);
  if (owner) {
    emailService
      .sendSubscriptionPaymentFailed({
        to: owner.email,
        tenantName: owner.tenantName,
        planName: plan?.name ?? sub.plan_id,
        amount: num(sub.total),
        currency: sub.currency.trim(),
        gateway: sub.gateway,
        keepsAccessUntil: sub.current_period_end ? new Date(sub.current_period_end).toISOString() : null,
      })
      .catch((err) => log.error("could not send the failed-renewal email", { reason: (err as Error)?.message }));
  }
  log.warn("subscription renewal failed; marked past_due", { gateway });
  return true;
}

/** The provider ended the subscription (cancelled, completed or exhausted retries). The paid period still runs out. */
export async function markEnded(
  gateway: SubscriptionGateway,
  gatewaySubscriptionId: string,
  status: "cancelled" | "expired"
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE tenant_subscriptions SET status = $3, cancelled_at = COALESCE(cancelled_at, now()), updated_at = now()
     WHERE gateway = $1 AND gateway_subscription_id = $2 AND status IN ('active', 'past_due')
     RETURNING id`,
    [gateway, gatewaySubscriptionId, status]
  );
  return Boolean(row);
}

export async function syncCancelAtPeriodEnd(
  gateway: SubscriptionGateway,
  gatewaySubscriptionId: string,
  cancelAtPeriodEnd: boolean
): Promise<void> {
  await query(
    `UPDATE tenant_subscriptions SET cancel_at_period_end = $3, updated_at = now()
     WHERE gateway = $1 AND gateway_subscription_id = $2 AND status IN ('active', 'past_due')`,
    [gateway, gatewaySubscriptionId, cancelAtPeriodEnd]
  );
}

/** Customer action: stop renewing. The provider is told first; nothing changes locally if that call fails. */
export async function cancelSubscription(
  tenantId: string,
  actor: { userId?: string; email?: string; ipAddress?: string }
): Promise<SubscriptionSummary> {
  const sub = await findLiveSubscription(tenantId);
  if (!sub) throw httpError(404, "You don't have an active subscription to cancel.");
  if (sub.cancel_at_period_end) return toSummary(sub);

  if (sub.gateway === "stripe") await cancelStripeSubscription(sub.gateway_subscription_id);
  else if (sub.gateway === "razorpay") await cancelRazorpaySubscription(sub.gateway_subscription_id);

  const updated = await queryOne<SubscriptionRow>(
    "UPDATE tenant_subscriptions SET cancel_at_period_end = true, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *",
    [sub.id, tenantId]
  );
  await AuditService.record({
    tenantId,
    userId: isUuid(actor.userId) ? actor.userId : undefined,
    userEmail: actor.email,
    action: "subscription.cancel",
    resourceType: "subscription",
    resourceId: sub.id,
    details: { planId: sub.plan_id, gateway: sub.gateway, activeUntil: sub.current_period_end },
    ipAddress: actor.ipAddress,
  }).catch((err) => log.error("could not write the audit entry for a cancellation", { reason: (err as Error)?.message }));

  return toSummary(updated ?? sub);
}

/** Stops a subscription at the provider (no further charges) and marks it cancelled here. Throws if the provider refuses. */
async function endAtProvider(sub: SubscriptionRow): Promise<void> {
  if (sub.gateway === "stripe") await cancelStripeSubscription(sub.gateway_subscription_id);
  else if (sub.gateway === "razorpay") await cancelRazorpaySubscription(sub.gateway_subscription_id);
  await query(
    `UPDATE tenant_subscriptions
     SET status = 'cancelled', cancel_at_period_end = true, cancelled_at = COALESCE(cancelled_at, now()),
         superseded_at = COALESCE(superseded_at, now()), updated_at = now()
     WHERE id = $1`,
    [sub.id]
  );
}

/**
 * After an upgrade: the plan the customer was renewing automatically is replaced, so its renewals must stop.
 * The subscription is flagged first, so a charge that still arrives is never applied as a renewal; if the provider
 * cannot be reached the hourly `retrySupersededCancellations` keeps trying.
 */
export async function supersedeLiveSubscription(tenantId: string): Promise<"none" | "cancelled" | "pending_retry"> {
  const sub = await findLiveSubscription(tenantId);
  if (!sub) return "none";
  await query("UPDATE tenant_subscriptions SET superseded_at = COALESCE(superseded_at, now()), updated_at = now() WHERE id = $1", [sub.id]);
  try {
    await endAtProvider(sub);
    return "cancelled";
  } catch (err) {
    log.error("could not cancel the replaced subscription at the provider yet", {
      subscriptionId: sub.id,
      gateway: sub.gateway,
      reason: (err as Error)?.message,
    });
    return "pending_retry";
  }
}

/** Hourly: retries the provider cancellation of subscriptions that an upgrade replaced. Returns how many ended. */
export async function retrySupersededCancellations(): Promise<number> {
  const stuck = await query<SubscriptionRow>(
    "SELECT * FROM tenant_subscriptions WHERE superseded_at IS NOT NULL AND status IN ('active', 'past_due') LIMIT 25"
  );
  let ended = 0;
  for (const sub of stuck) {
    try {
      await endAtProvider(sub);
      ended += 1;
    } catch (err) {
      log.error("replaced subscription is still not cancelled at the provider", {
        subscriptionId: sub.id,
        reason: (err as Error)?.message,
      });
    }
  }
  return ended;
}

/** Stripe's hosted page for changing the card. Only available to Stripe (card) subscriptions. */
export async function openBillingPortal(tenantId: string): Promise<string> {
  const row = await queryOne<{ stripe_customer_id: string | null }>(
    "SELECT stripe_customer_id FROM tenants WHERE id = $1",
    [tenantId]
  );
  if (!row?.stripe_customer_id) {
    throw httpError(400, "Card management is only available for card subscriptions.");
  }
  return createStripePortalSession(row.stripe_customer_id, `${publicAppUrl() || "http://localhost:5173"}/settings?tab=billing`);
}

// ───────────── development-only helpers (BILLING_SANDBOX=true): try renewals and failures without a provider ─────────────

function requireSandbox(): void {
  if (!sandboxEnabled()) throw httpError(404, "Not found");
}

/** Simulates the next automatic renewal of the workspace's sandbox subscription. */
export async function sandboxRenew(tenantId: string): Promise<SubscriptionSummary> {
  requireSandbox();
  const sub = await findLiveSubscription(tenantId);
  if (!sub || sub.gateway !== "sandbox") throw httpError(404, "No sandbox subscription to renew.");
  const outcome = await recordRenewal({
    gateway: "sandbox",
    gatewaySubscriptionId: sub.gateway_subscription_id,
    paymentId: `sandbox_renewal_${uuidv4()}`,
    amountMinor: toMinorUnits(num(sub.total), sub.currency.trim() as BillingCurrency),
    currency: sub.currency.trim(),
  });
  if (outcome !== "renewed") throw httpError(409, "The renewal could not be applied.");
  return (await getSubscriptionSummary(tenantId)) as SubscriptionSummary;
}

/** Simulates a failed renewal of the workspace's sandbox subscription. */
export async function sandboxFailRenewal(tenantId: string): Promise<SubscriptionSummary> {
  requireSandbox();
  const sub = await findLiveSubscription(tenantId);
  if (!sub || sub.gateway !== "sandbox") throw httpError(404, "No sandbox subscription to fail.");
  await markPastDue("sandbox", sub.gateway_subscription_id);
  return (await getSubscriptionSummary(tenantId)) as SubscriptionSummary;
}
