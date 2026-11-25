import { v4 as uuidv4 } from "uuid";
import { query, queryOne, withTransaction } from "../../db/pool";
import { AuditService } from "../audit/audit.service";
import { logger } from "../../utils/logger";
import { httpError, isUuid } from "../../utils/http-error";
import {
  mapPaymentRow,
  recordSubscriptionPayment,
  SubscriptionPaymentRecord,
  WorkspaceSubscriptionItem,
} from "../platform-governance/platform-subscriptions.service";
import type { BillingProfile, PlanConfig } from "./billing.service";
import {
  gstRatePercent,
  publicAppUrl,
  razorpayConfigured,
  sandboxEnabled,
  sellerDetails,
  stripeConfigured,
} from "./config";
import { BillingCurrency, toMinorUnits } from "./currency";
import {
  GatewayPaymentState,
  createRazorpayPaymentLink,
  createRazorpayPlan,
  createRazorpaySubscription,
  createStripeCheckout,
  fetchRazorpayPaymentLink,
  fetchRazorpaySubscription,
  fetchStripeCheckout,
} from "./gateways";
import { computeTax } from "./gst";
import { createSubscriptionFromCheckout, findLiveSubscription, fromUnix, supersedeLiveSubscription } from "./subscription.service";
import { assessUpgrade } from "./proration.service";

/**
 * Paid checkouts (plan/017, Phases 2 and 3). The rules that make this safe:
 *  - WE decide the price (plan price in the workspace's currency + tax) and store it in
 *    billing_checkout_sessions before the customer is sent to the gateway.
 *  - A plan is only activated from evidence that comes from the provider (a signed webhook or a direct
 *    lookup with our API key), and only if the paid amount and currency equal what we stored.
 *  - Activation is idempotent: the webhook and the status poll can both arrive, in any order, any number
 *    of times, and the workspace is credited exactly once.
 *  - A checkout is either ONE payment or an auto-renewing SUBSCRIPTION (`mode`). For a subscription the
 *    first payment is confirmed here; the renewals that follow are handled in subscription.service.
 */

const log = logger.child({ module: "billing-checkout" });

/** What the provider must charge for a checkout: the invoice total minus any upgrade credit, in minor units. */
function payableMinorOf(row: Pick<CheckoutRow, "currency" | "total" | "credit_total">): number {
  const currency = row.currency.trim() as BillingCurrency;
  return toMinorUnits(Number(row.total), currency) - toMinorUnits(Number(row.credit_total ?? 0), currency);
}

export type CheckoutGateway = "stripe" | "razorpay" | "sandbox";
export type CheckoutRowStatus = "pending" | "paid" | "failed" | "expired";
export type CheckoutMode = "payment" | "subscription";

/** Razorpay charges a subscription for this many cycles before it completes (10 years either way). */
const RAZORPAY_TOTAL_COUNT: Record<"monthly" | "yearly", number> = { monthly: 120, yearly: 10 };

export interface CheckoutRow {
  id: string;
  tenant_id: string;
  gateway: CheckoutGateway;
  gateway_session_id: string;
  plan_id: string;
  billing_cycle: "monthly" | "yearly";
  currency: string;
  subtotal: string;
  tax_amount: string;
  tax_rate: string;
  total: string;
  buyer_tax_id: string | null;
  status: CheckoutRowStatus;
  payment_id: string | null;
  created_by: string | null;
  mode: CheckoutMode;
  /** An upgrade: the old invoice whose unused time is credited, and how much (fixed when the checkout starts). */
  credit_invoice_id: string | null;
  credit_subtotal: string;
  credit_tax: string;
  credit_total: string;
}

export interface CheckoutSessionResult {
  /** The provider's session id (what the browser comes back with after paying). */
  sessionId: string;
  checkoutUrl?: string;
  /** "free" when a free plan was activated without a payment. */
  gateway: CheckoutGateway | "free";
  planId: string;
  planName: string;
  billingCycle: "monthly" | "yearly";
  currency: string;
  subtotal: number;
  taxAmount: number;
  taxRate: number;
  taxLabel: string | null;
  /** What is charged NOW: the invoice total minus any upgrade credit (at every renewal: subtotal + tax). */
  amount: number;
  /** The full invoice for the new plan (subtotal + tax). Equals `amount` unless a credit is applied. */
  invoiceTotal: number;
  /** An upgrade: the unused time of the current plan, credited by a credit note issued with the new invoice. */
  credit: { total: number; subtotal: number; tax: number; invoiceNumber: string; unusedDays: number } | null;
  /** True when the plan renews by itself every cycle until cancelled. */
  autoRenew: boolean;
  isFree: boolean;
  isSandbox: boolean;
  notes?: string;
  /** Set when the plan was free and is already active. */
  activated?: { payment: SubscriptionPaymentRecord; subscription: WorkspaceSubscriptionItem };
}

export interface CheckoutStatusResult {
  status: CheckoutRowStatus;
  sessionId: string;
  planId: string;
  billingCycle: string;
  currency: string;
  /** What was (or is to be) paid: the invoice total minus any upgrade credit. */
  amount: number;
  subtotal: number;
  taxAmount: number;
  taxRate: number;
  autoRenew: boolean;
  message: string;
  payment?: SubscriptionPaymentRecord;
  subscription?: WorkspaceSubscriptionItem;
}

export interface PaymentEvidence {
  /** The provider's id of the actual payment (used as the idempotency key). */
  paymentId: string;
  amountMinor: number;
  currency: string;
  /** For subscription checkouts: the provider's subscription and the period this payment covers. */
  subscription?: {
    id: string;
    customerId: string | null;
    periodStart?: Date;
    periodEnd?: Date;
  };
}

export type ConfirmOutcome =
  | { outcome: "activated"; payment: SubscriptionPaymentRecord; subscription: WorkspaceSubscriptionItem }
  | { outcome: "already_paid" }
  | { outcome: "mismatch" };

const money = (value: string | number): number => (typeof value === "number" ? value : parseFloat(value || "0"));

/** Where gateways send the customer back to. Built from our own config, never from the request. */
function returnUrls(): { success: string; cancel: string } {
  const base = publicAppUrl() || "http://localhost:5173";
  return {
    success: `${base}/settings?tab=billing&checkout=success`,
    cancel: `${base}/settings?tab=billing&checkout=cancel`,
  };
}

export async function findCheckoutByGatewaySession(
  gateway: CheckoutGateway,
  gatewaySessionId: string
): Promise<CheckoutRow | null> {
  return queryOne<CheckoutRow>(
    "SELECT * FROM billing_checkout_sessions WHERE gateway = $1 AND gateway_session_id = $2",
    [gateway, gatewaySessionId]
  );
}

async function markCheckout(id: string, status: CheckoutRowStatus): Promise<void> {
  await query("UPDATE billing_checkout_sessions SET status = $2 WHERE id = $1 AND status = 'pending'", [id, status]);
}

/** The Razorpay plan (recurring price) for this amount, created once and reused by later checkouts. */
async function getOrCreateRazorpayPlan(params: {
  planId: string;
  planName: string;
  billingCycle: "monthly" | "yearly";
  currency: string;
  amountMinor: number;
}): Promise<string> {
  const key = [params.planId, params.billingCycle, params.currency, params.amountMinor];
  const cached = await queryOne<{ gateway_plan_id: string }>(
    `SELECT gateway_plan_id FROM billing_gateway_plans
     WHERE gateway = 'razorpay' AND plan_id = $1 AND billing_cycle = $2 AND currency = $3 AND amount_minor = $4`,
    key
  );
  if (cached) return cached.gateway_plan_id;

  const gatewayPlanId = await createRazorpayPlan({
    period: params.billingCycle,
    amountMinor: params.amountMinor,
    currency: params.currency,
    name: `Omni Platform - ${params.planName} (${params.billingCycle})`,
    notes: { planId: params.planId },
  });
  await query(
    `INSERT INTO billing_gateway_plans (gateway, plan_id, billing_cycle, currency, amount_minor, gateway_plan_id)
     VALUES ('razorpay', $1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [...key, gatewayPlanId]
  );
  return gatewayPlanId;
}

/** Creates a checkout for a paid plan. The caller has already resolved the plan and the workspace's billing. */
export async function startPaidCheckout(input: {
  tenantId: string;
  actorId?: string;
  actorEmail?: string;
  plan: PlanConfig;
  billingCycle: "monthly" | "yearly";
  billing: BillingProfile;
  gateway: CheckoutGateway;
  /** Renew automatically every cycle (a subscription) instead of taking a single payment. */
  autoRenew?: boolean;
}): Promise<CheckoutSessionResult> {
  const { tenantId, actorId, actorEmail, plan, billingCycle, billing } = input;
  const autoRenew = input.autoRenew === true;
  const currency: BillingCurrency = billing.currency;

  const monthly = plan.priceMonthly || 0;
  const subtotal = billingCycle === "yearly" ? (plan.priceYearly ?? monthly * 10) : monthly;
  // Where the tax goes (CGST+SGST or IGST) depends on the customer's state, so an Indian invoice cannot be
  // priced without it.
  if (currency === "INR" && gstRatePercent() > 0 && !billing.stateCode) {
    throw httpError(
      400,
      "Choose your state in Billing details first. It decides how GST is shown on your invoice.",
      { code: "BILLING_STATE_REQUIRED" }
    );
  }
  const tax = computeTax(subtotal, currency, billing.country, {
    buyerStateCode: billing.stateCode,
    sellerStateCode: sellerDetails().stateCode,
    buyerTaxId: billing.taxId,
  });

  // A workspace has one renewing subscription at a time: changing plan mid-subscription needs proration, which
  // is not built yet, so ask the customer to end the current one first instead of charging twice.
  if (autoRenew && (await findLiveSubscription(tenantId))) {
    throw httpError(
      409,
      "You already have an automatically renewing plan. Cancel its renewal first (it stays active until the period you paid for ends), then choose a new plan.",
      { expose: true }
    );
  }

  // Upgrading mid-period: credit the unused time of the current plan. A lower plan waits for the period to end.
  const assessment = await assessUpgrade({
    tenantId,
    newPlanId: plan.id,
    newBillingCycle: billingCycle,
    newSubtotal: tax.subtotal,
    newTotal: tax.total,
    currency,
  });
  if (assessment.kind === "blocked") {
    throw httpError(400, assessment.message, {
      code: assessment.reason === "lower_plan" ? "LOWER_PLAN_AFTER_PERIOD" : "UPGRADE_NOT_POSSIBLE",
      details: { activeUntil: assessment.activeUntil },
    });
  }
  const credit = assessment.kind === "credit" ? assessment.credit : null;
  if (credit && autoRenew) {
    throw httpError(
      400,
      "An upgrade with credit is paid once. Choose the upgrade without automatic renewal, and turn renewal on when this period ends.",
      { code: "UPGRADE_CREDIT_ONE_TIME" }
    );
  }
  const payableMinor = toMinorUnits(tax.total, currency) - (credit ? toMinorUnits(credit.total, currency) : 0);

  // The gateway must be configured; there is no silent fall back to a fake session.
  let gateway = input.gateway;
  const unavailable =
    (gateway === "stripe" && !stripeConfigured()) || (gateway === "razorpay" && !razorpayConfigured());
  if (unavailable && sandboxEnabled()) gateway = "sandbox";
  if (unavailable && !sandboxEnabled()) {
    throw httpError(503, "Online payments are not available right now. Please contact support.", { expose: true });
  }
  if (gateway === "sandbox" && !sandboxEnabled()) {
    throw httpError(503, "Online payments are not available right now. Please contact support.", { expose: true });
  }

  // Record the price BEFORE talking to the provider, so a payment can always be matched to a row.
  const row = await queryOne<CheckoutRow>(
    `INSERT INTO billing_checkout_sessions (
       tenant_id, gateway, gateway_session_id, plan_id, billing_cycle, currency,
       subtotal, tax_amount, tax_rate, total, buyer_tax_id, created_by, mode,
       credit_invoice_id, credit_subtotal, credit_tax, credit_total
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING *`,
    [
      tenantId,
      gateway,
      `pending:${uuidv4()}`,
      plan.id,
      billingCycle,
      currency,
      tax.subtotal,
      tax.taxAmount,
      tax.taxRate,
      tax.total,
      billing.taxId,
      actorId ?? null,
      autoRenew ? "subscription" : "payment",
      credit?.invoiceId ?? null,
      credit?.subtotal ?? 0,
      credit?.tax ?? 0,
      credit?.total ?? 0,
    ]
  );
  if (!row) throw httpError(500, "Could not start the checkout");

  const urls = returnUrls();
  const amountMinor = payableMinor;
  const productName = `Omni Platform - ${plan.name} Plan (${billingCycle})`;
  const notes = { tenantId, planId: plan.id, billingCycle, purpose: "saas_subscription", checkoutId: row.id };

  let gatewaySessionId: string;
  let checkoutUrl: string;
  try {
    if (gateway === "stripe") {
      const created = await createStripeCheckout({
        amountMinor,
        currency,
        productName,
        referenceId: row.id,
        metadata: notes,
        successUrl: `${urls.success}&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: urls.cancel,
        customerEmail: actorEmail,
        recurringInterval: autoRenew ? (billingCycle === "yearly" ? "year" : "month") : undefined,
      });
      gatewaySessionId = created.id;
      checkoutUrl = created.url;
    } else if (gateway === "razorpay" && autoRenew) {
      const razorpayPlanId = await getOrCreateRazorpayPlan({
        planId: plan.id,
        planName: plan.name,
        billingCycle,
        currency,
        amountMinor,
      });
      const created = await createRazorpaySubscription({
        planId: razorpayPlanId,
        totalCount: RAZORPAY_TOTAL_COUNT[billingCycle],
        notes,
      });
      gatewaySessionId = created.id;
      checkoutUrl = created.url;
    } else if (gateway === "razorpay") {
      const created = await createRazorpayPaymentLink({
        amountMinor,
        currency,
        description: productName,
        referenceId: row.id,
        notes,
        callbackUrl: urls.success,
        customer: { name: billing.name ?? undefined, email: actorEmail },
      });
      gatewaySessionId = created.id;
      checkoutUrl = created.url;
    } else {
      gatewaySessionId = `sandbox_${row.id}`;
      checkoutUrl = `${urls.success}&session_id=${gatewaySessionId}`;
    }
  } catch (err) {
    await markCheckout(row.id, "failed");
    throw err;
  }

  await query("UPDATE billing_checkout_sessions SET gateway_session_id = $2 WHERE id = $1", [row.id, gatewaySessionId]);
  log.info("checkout started", { tenantId, planId: plan.id, gateway, currency, billingCycle, autoRenew });

  return {
    sessionId: gatewaySessionId,
    checkoutUrl,
    gateway,
    planId: plan.id,
    planName: plan.name,
    billingCycle,
    currency,
    subtotal: tax.subtotal,
    taxAmount: tax.taxAmount,
    taxRate: tax.taxRate,
    taxLabel: tax.taxLabel,
    amount: payableMinor / 100,
    invoiceTotal: tax.total,
    credit: credit
      ? { total: credit.total, subtotal: credit.subtotal, tax: credit.tax, invoiceNumber: credit.invoiceNumber, unusedDays: credit.unusedDays }
      : null,
    autoRenew,
    isFree: false,
    isSandbox: gateway === "sandbox",
    notes: gateway === "sandbox" ? "Sandbox checkout (test environment only): no real payment is taken." : undefined,
  };
}

/**
 * Credits the workspace for a paid checkout, exactly once. Safe to call from a webhook and from the status
 * poll at the same time: the checkout row is locked, and the gateway payment id is unique in the ledger.
 * For a subscription checkout it also creates the subscription row, so the renewals that follow are recognised.
 */
export async function confirmCheckoutPayment(row: CheckoutRow, evidence: PaymentEvidence): Promise<ConfirmOutcome> {
  let supersedeAfterCommit = false;
  const outcome = await withTransaction<ConfirmOutcome>(async (client) => {
    const locked = (
      await client.query<CheckoutRow>("SELECT * FROM billing_checkout_sessions WHERE id = $1 FOR UPDATE", [row.id])
    ).rows[0];
    if (!locked) throw httpError(404, "Checkout not found");
    if (locked.status === "paid") return { outcome: "already_paid" };

    // The price is the one WE stored, never the one the browser or the webhook claims.
    const expectedMinor = payableMinorOf(locked);
    if (evidence.currency.toUpperCase() !== locked.currency.trim().toUpperCase() || evidence.amountMinor !== expectedMinor) {
      await client.query("UPDATE billing_checkout_sessions SET status = 'failed' WHERE id = $1", [locked.id]);
      log.error("payment does not match the checkout; plan NOT activated", {
        checkoutId: locked.id,
        expectedMinor,
        paidMinor: evidence.amountMinor,
        expectedCurrency: locked.currency.trim(),
        paidCurrency: evidence.currency,
      });
      return { outcome: "mismatch" };
    }

    const seller = sellerDetails();
    const taxAmount = money(locked.tax_amount);
    const isSubscription = locked.mode === "subscription";
    // Razorpay's subscription id IS the checkout's provider id; Stripe reports its own in the confirmation.
    const subscriptionInfo =
      evidence.subscription ??
      (isSubscription && locked.gateway === "razorpay"
        ? { id: locked.gateway_session_id, customerId: null }
        : isSubscription && locked.gateway === "sandbox"
        ? { id: `sandbox_sub_${locked.id}`, customerId: null }
        : undefined);

    const credit = locked.credit_invoice_id
      ? {
          invoiceId: locked.credit_invoice_id,
          subtotal: money(locked.credit_subtotal),
          tax: money(locked.credit_tax),
          total: money(locked.credit_total),
        }
      : undefined;
    let result: Awaited<ReturnType<typeof recordSubscriptionPayment>>;
    try {
      result = await recordSubscriptionPayment({
      tenantId: locked.tenant_id,
      planId: locked.plan_id,
      amount: money(locked.total),
      currency: locked.currency.trim(),
      billingCycle: locked.billing_cycle,
      paymentMethod: locked.gateway,
      transactionReference: evidence.paymentId,
      gateway: locked.gateway,
      gatewayPaymentId: evidence.paymentId,
      periodStart: evidence.subscription?.periodStart?.toISOString(),
      periodEnd: evidence.subscription?.periodEnd?.toISOString(),
      taxAmount,
      taxRate: money(locked.tax_rate),
      taxLabel: taxAmount > 0 ? "GST" : null,
      buyerTaxId: locked.buyer_tax_id,
      sellerTaxId: taxAmount > 0 ? seller.taxId : null,
      notes: `Self-service subscription via ${locked.gateway.toUpperCase()}${isSubscription ? " (renews automatically)" : ""}`,
      sendReceiptEmail: true,
      credit,
      });
    } catch (err) {
      if ((err as { code?: string })?.code !== "CREDIT_EXCEEDS_INVOICE") throw err;
      // The old invoice was credited by someone else after this checkout started: the credit we promised is gone.
      // Same safe outcome as an amount mismatch: nothing is activated and the payment needs a manual refund.
      await client.query("UPDATE billing_checkout_sessions SET status = 'failed' WHERE id = $1", [locked.id]);
      log.error("upgrade credit no longer available; plan NOT activated, the payment must be refunded", {
        checkoutId: locked.id,
        gatewayPaymentId: evidence.paymentId,
      });
      return { outcome: "mismatch" };
    }

    if (isSubscription && subscriptionInfo) {
      await createSubscriptionFromCheckout(client, locked, {
        gatewaySubscriptionId: subscriptionInfo.id,
        customerId: subscriptionInfo.customerId,
        periodStart: evidence.subscription?.periodStart,
        periodEnd: evidence.subscription?.periodEnd,
      });
    }

    await client.query(
      "UPDATE billing_checkout_sessions SET status = 'paid', paid_at = now(), payment_id = $2 WHERE id = $1",
      [locked.id, result.payment.id]
    );
    supersedeAfterCommit = Boolean(credit);
    return { outcome: "activated", payment: result.payment, subscription: result.subscription };
  });

  // An upgrade replaces the plan the customer was on: stop its automatic renewals at the provider (after the commit,
  // so a provider outage can never undo a payment that was already taken; a failed attempt is retried hourly).
  if (outcome.outcome === "activated" && supersedeAfterCommit) {
    await supersedeLiveSubscription(row.tenant_id).catch((err) =>
      log.error("could not stop the replaced subscription (retried hourly)", { reason: (err as Error)?.message })
    );
  }

  if (outcome.outcome === "activated") {
    await AuditService.record({
      tenantId: row.tenant_id,
      userId: isUuid(row.created_by) ? row.created_by : undefined,
      action: "plan.upgrade",
      resourceType: "subscription",
      resourceId: outcome.payment.invoiceNumber,
      details: {
        planId: row.plan_id,
        amount: outcome.payment.amount,
        currency: outcome.payment.currency,
        billingCycle: row.billing_cycle,
        gateway: row.gateway,
        autoRenew: row.mode === "subscription",
        invoiceNumber: outcome.payment.invoiceNumber,
      },
    }).catch((err) => log.error("could not write the audit entry for a paid checkout", { reason: (err as Error)?.message }));
    log.info("subscription activated from a verified payment", { tenantId: row.tenant_id, planId: row.plan_id, gateway: row.gateway });
  }
  return outcome;
}

async function toStatusResult(row: CheckoutRow, message: string): Promise<CheckoutStatusResult> {
  const result: CheckoutStatusResult = {
    status: row.status,
    sessionId: row.gateway_session_id,
    planId: row.plan_id,
    billingCycle: row.billing_cycle,
    currency: row.currency.trim(),
    amount: payableMinorOf(row) / 100,
    subtotal: money(row.subtotal),
    taxAmount: money(row.tax_amount),
    taxRate: money(row.tax_rate),
    autoRenew: row.mode === "subscription",
    message,
  };
  if (row.status === "paid" && row.payment_id) {
    const payment = await queryOne<Record<string, any>>(
      "SELECT * FROM platform_subscription_payments WHERE id = $1 AND tenant_id = $2",
      [row.payment_id, row.tenant_id]
    );
    if (payment) {
      result.payment = mapPaymentRow(payment, "");
    }
  }
  return result;
}

/**
 * Where a checkout stands. If it is still pending we ask the provider directly (the webhook may not have
 * arrived yet, or the customer is back on the page first) and activate through the same function the
 * webhooks use. `ref` is the provider session id the browser came back with, or our own checkout id.
 * Scoped to the caller's workspace: another workspace's checkout is a 404.
 */
export async function getCheckoutStatus(tenantId: string, ref: string): Promise<CheckoutStatusResult> {
  const row = await queryOne<CheckoutRow>(
    "SELECT * FROM billing_checkout_sessions WHERE tenant_id = $1 AND (gateway_session_id = $2 OR id::text = $2)",
    [tenantId, ref]
  );
  if (!row) throw httpError(404, "Checkout not found");

  if (row.status === "paid") return toStatusResult(row, "Payment received. Your plan is active.");
  if (row.status !== "pending") {
    return toStatusResult(row, row.status === "expired" ? "This checkout expired. Start a new one." : "This checkout did not complete.");
  }

  let state: GatewayPaymentState;
  if (row.gateway === "sandbox") {
    if (!sandboxEnabled()) throw httpError(404, "Checkout not found");
    state = {
      paid: true,
      closed: false,
      amountMinor: payableMinorOf(row),
      currency: row.currency.trim(),
      paymentId: `sandbox_${row.id}`,
    };
  } else if (row.gateway === "stripe") {
    state = await fetchStripeCheckout(row.gateway_session_id);
  } else if (row.mode === "subscription") {
    state = await fetchRazorpaySubscription(row.gateway_session_id);
  } else {
    state = await fetchRazorpayPaymentLink(row.gateway_session_id);
  }

  if (state.paid && state.paymentId && state.amountMinor !== null && state.currency) {
    const confirmed = await confirmCheckoutPayment(row, {
      paymentId: state.paymentId,
      amountMinor: state.amountMinor,
      currency: state.currency,
      subscription: state.subscription
        ? {
            id: state.subscription.id,
            customerId: state.subscription.customerId,
            periodStart: fromUnix(state.subscription.periodStart),
            periodEnd: fromUnix(state.subscription.periodEnd),
          }
        : undefined,
    });
    const fresh = (await queryOne<CheckoutRow>("SELECT * FROM billing_checkout_sessions WHERE id = $1", [row.id])) ?? row;
    if (confirmed.outcome === "mismatch") {
      return toStatusResult(fresh, "The payment did not match this order, so the plan was not changed. Please contact support.");
    }
    const result = await toStatusResult(fresh, "Payment received. Your plan is active.");
    if (confirmed.outcome === "activated") result.subscription = confirmed.subscription;
    return result;
  }

  if (state.closed) {
    await markCheckout(row.id, "expired");
    return toStatusResult({ ...row, status: "expired" }, "This checkout expired. Start a new one.");
  }
  return toStatusResult(row, "Waiting for the payment to complete.");
}
