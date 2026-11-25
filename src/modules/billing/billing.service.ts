import { v4 as uuidv4 } from "uuid";
import { query, queryOne } from "../../db/pool";
import { getMongoDb } from "../../db/mongo";
import { AuditService } from "../audit/audit.service";
import { logger } from "../../utils/logger";
import {
  listPlatformPlans,
  getPlatformPlanById,
  PlanPrice,
  PlatformPlanItem,
} from "../platform-governance/platform-plans.service";
import { httpError } from "../../utils/http-error";
import {
  BillingCurrency,
  DEFAULT_BILLING_CURRENCY,
  currencyForCountry,
  gatewayForCurrency,
  isSupportedCurrency,
  normalizeCountryCode,
} from "./currency";
import { sandboxEnabled, sellerDetails } from "./config";
import { normalizeStateCode, stateCodeFromGstin } from "./gst-states";
import {
  ALL_FEATURES_ON,
  EnforcementMode,
  FeatureFlags,
  UNLIMITED,
  enforcementMode,
  getEntitlements,
  invalidateEntitlements,
} from "./plan-limits.service";
import { computeTax } from "./gst";
import { assessUpgrade } from "./proration.service";
import { CheckoutSessionResult, getCheckoutStatus, startPaidCheckout } from "./checkout.service";

export type { CheckoutSessionResult } from "./checkout.service";
import {
  recordSubscriptionPayment,
  listSubscriptionPayments,
  SubscriptionPaymentRecord,
} from "../platform-governance/platform-subscriptions.service";

const log = logger.child({ module: "billing-service" });

export interface PlanConfig {
  id: string;
  name: string;
  description: string;
  /** Price in `currency` (the viewing workspace's billing currency); 0 when `priceAvailable` is false. */
  priceMonthly: number;
  priceYearly?: number;
  currency?: string;
  /** False when the plan has no price in the workspace's currency yet: it cannot be bought. */
  priceAvailable: boolean;
  /** Every currency this plan is sold in. */
  prices?: PlanPrice[];
  maxChannels: number;
  maxContacts: number;
  maxMonthlyMessages: number;
  maxMonthlyAiQueries: number;
  features: string[];
  /** Gated features this plan includes (plan/017 Phase 4). */
  featureFlags?: FeatureFlags;
  badgeText?: string | null;
}

/**
 * Display-only fallback for a database with no plans yet (limits and copy only). Prices live in
 * platform_plan_prices, so these plans are not purchasable: checkout never uses this table.
 */
export const PLAN_TIERS: Record<string, PlanConfig> = {
  free: {
    id: "free",
    name: "Free Sandbox",
    description: "Ideal for testing and single-channel experimentation",
    priceMonthly: 0,
    priceYearly: 0,
    priceAvailable: false,
    maxChannels: 1,
    maxContacts: 500,
    maxMonthlyMessages: 2000,
    maxMonthlyAiQueries: 100,
    features: ["1 Active Channel", "500 Contacts", "2k Messages/mo", "Basic Flow Builder", "Community Support"],
    badgeText: "Sandbox",
  },
  starter: {
    id: "starter",
    name: "Starter Growth",
    description: "For small teams scaling messaging and customer service",
    priceMonthly: 0,
    priceYearly: 0,
    priceAvailable: false,
    maxChannels: 3,
    maxContacts: 3000,
    maxMonthlyMessages: 15000,
    maxMonthlyAiQueries: 500,
    features: [
      "3 Connected Channels",
      "3,000 Verified Contacts",
      "15k Messages/mo",
      "AI Smart Copilot",
      "WhatsApp Cloud API Integration",
      "Standard Email Support",
    ],
    badgeText: "Popular",
  },
  pro: {
    id: "pro",
    name: "Pro Scale",
    description: "For fast-growing organizations requiring high capacity & AI agents",
    priceMonthly: 0,
    priceYearly: 0,
    priceAvailable: false,
    maxChannels: 10,
    maxContacts: 25000,
    maxMonthlyMessages: 100000,
    maxMonthlyAiQueries: 5000,
    features: [
      "10 Connected Channels",
      "25,000 Contacts",
      "100k Messages/mo",
      "Full RAG Knowledge Bases",
      "Automated Intent Router",
      "Team RBAC & Developer API Keys",
      "Priority 24/7 Support",
    ],
    badgeText: "Recommended",
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise Custom",
    description: "Dedicated infrastructure, SLA guarantees, and limitless capacity",
    priceMonthly: 0,
    priceYearly: 0,
    priceAvailable: false,
    maxChannels: 50,
    maxContacts: 500000,
    maxMonthlyMessages: 1000000,
    maxMonthlyAiQueries: 50000,
    features: [
      "Unlimited Channels",
      "500,000+ Contacts",
      "1M+ Messages/mo",
      "Custom Fine-Tuned AI Models",
      "Audit Trail & GDPR Compliance Suite",
      "Custom SLA & Dedicated Account Manager",
    ],
    badgeText: "Enterprise",
  },
};

export interface UsageMetric {
  used: number;
  limit: number;
  percentage: number;
  unit: string;
}

export interface WorkspaceUsageSummary {
  tenantId: string;
  tenantName: string;
  planId: string;
  planName: string;
  planStatus: string;
  planExpiresAt?: string | null;
  billingCycleEnd: string;
  /** ISO country and the currency prices are shown and charged in. */
  billingCountry: string | null;
  billingCurrency: BillingCurrency;
  /** True after the first paid payment: country/currency changes then need platform staff. */
  currencyLocked: boolean;
  /** Tax added on top of plan prices for this workspace (GST for India), so checkout can show it up front. */
  tax: { ratePercent: number; label: string | null };
  /** What the current plan includes, and whether limits are enforced (off | warn | enforce). */
  features: FeatureFlags;
  enforcement: EnforcementMode;
  metrics: {
    channels: UsageMetric;
    contacts: UsageMetric;
    monthlyMessages: UsageMetric;
    monthlyAiQueries: UsageMetric;
  };
  stats: {
    totalConversations: number;
    totalDealsCount: number;
    totalDealsValue: number;
    activeAgentsCount: number;
  };
  availablePlans: PlanConfig[];
}

export interface CreateCheckoutSessionParams {
  tenantId: string;
  actorId?: string;
  actorEmail?: string;
  planId: string;
  billingCycle?: "monthly" | "yearly";
  /** Renew automatically every cycle until cancelled (a subscription) instead of a single payment. */
  autoRenew?: boolean;
}

export interface BillingProfile {
  country: string | null;
  currency: BillingCurrency;
  taxId: string | null;
  name: string | null;
  address: Record<string, string> | null;
  /** GST state code (place of supply). Required to pay in INR: it decides CGST+SGST or IGST. */
  stateCode: string | null;
  currencyLocked: boolean;
}

const ADDRESS_FIELDS = ["line1", "line2", "city", "state", "postalCode"] as const;
const GSTIN_PATTERN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** A plan as one workspace sees it: priced in that workspace's currency. */
function toPlanConfig(plan: PlatformPlanItem, currency: BillingCurrency): PlanConfig {
  const price = plan.prices.find((p) => p.isActive && p.currency.toUpperCase() === currency);
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description || "",
    priceMonthly: price?.priceMonthly ?? 0,
    priceYearly: price?.priceYearly ?? 0,
    currency,
    priceAvailable: Boolean(price),
    prices: plan.prices,
    maxChannels: plan.maxChannels,
    maxContacts: plan.maxContacts,
    maxMonthlyMessages: plan.maxMonthlyMessages,
    maxMonthlyAiQueries: plan.maxMonthlyAiQueries,
    features: plan.features,
    featureFlags: plan.featureFlags,
    badgeText: plan.badgeText,
  };
}

export class BillingService {
  /**
   * Billing country, currency and tax details of a workspace. The currency always follows the country
   * (IN -> INR, everything else USD) unless an older row has none, in which case the country decides.
   */
  public static async getBillingProfile(tenantId: string): Promise<BillingProfile> {
    const row = await queryOne<{
      billing_country: string | null;
      billing_currency: string | null;
      billing_tax_id: string | null;
      billing_name: string | null;
      billing_address: Record<string, string> | null;
      billing_state_code: string | null;
      currency_locked_at: string | null;
    }>(
      `SELECT billing_country, billing_currency, billing_tax_id, billing_name, billing_address,
              billing_state_code, currency_locked_at
       FROM tenants WHERE id = $1`,
      [tenantId]
    );
    if (!row) throw httpError(404, "Workspace not found");

    const country = row.billing_country ? row.billing_country.trim().toUpperCase() : null;
    const storedCurrency = row.billing_currency ? row.billing_currency.trim().toUpperCase() : "";
    return {
      country,
      currency: isSupportedCurrency(storedCurrency) ? storedCurrency : currencyForCountry(country),
      taxId: row.billing_tax_id,
      name: row.billing_name,
      address: row.billing_address,
      stateCode: row.billing_state_code ? row.billing_state_code.trim() : null,
      currencyLocked: Boolean(row.currency_locked_at),
    };
  }

  /**
   * Updates billing details. Changing the country can change the currency, so it is refused once the
   * workspace has paid (the currency is locked); platform staff can still change it on request.
   */
  public static async updateBillingProfile(params: {
    tenantId: string;
    actorId?: string;
    actorEmail?: string;
    country?: unknown;
    taxId?: unknown;
    name?: unknown;
    address?: unknown;
    stateCode?: unknown;
    ipAddress?: string;
  }): Promise<BillingProfile> {
    const current = await this.getBillingProfile(params.tenantId);
    const updates: string[] = [];
    const values: unknown[] = [];
    const set = (column: string, value: unknown) => {
      values.push(value);
      updates.push(`${column} = $${values.length}`);
    };

    let effectiveCountry = current.country;
    if (params.country !== undefined) {
      const country = normalizeCountryCode(params.country);
      if (!country) throw httpError(400, "country must be a 2-letter ISO country code (for example IN or US)");
      const newCurrency = currencyForCountry(country);
      if (current.currencyLocked && newCurrency !== current.currency) {
        throw httpError(
          409,
          "Your billing currency is locked after your first payment. Contact support to change your billing country."
        );
      }
      effectiveCountry = country;
      set("billing_country", country);
      set("billing_currency", newCurrency);
      // A GST state only means something in India.
      if (country !== "IN") set("billing_state_code", null);
    }

    if (params.taxId !== undefined) {
      const taxId = typeof params.taxId === "string" ? params.taxId.trim().toUpperCase() : "";
      if (taxId.length > 32) throw httpError(400, "Tax ID must be 32 characters or fewer");
      if (taxId && effectiveCountry === "IN" && !GSTIN_PATTERN.test(taxId)) {
        throw httpError(400, "Enter a valid 15-character GSTIN (for example 22AAAAA0000A1Z5)");
      }
      set("billing_tax_id", taxId || null);
      // A GSTIN starts with the state code, so it also settles the place of supply (unless a state was sent too).
      const gstinState = taxId && effectiveCountry === "IN" ? stateCodeFromGstin(taxId) : null;
      if (taxId && effectiveCountry === "IN" && !gstinState) {
        throw httpError(400, "The first two digits of the GSTIN are not a valid GST state code");
      }
      if (gstinState) {
        const chosen = params.stateCode === undefined ? null : normalizeStateCode(params.stateCode);
        if (chosen && chosen !== gstinState) {
          throw httpError(400, "The state you chose does not match the first two digits of the GSTIN");
        }
        set("billing_state_code", gstinState);
      }
    }

    if (params.stateCode !== undefined && effectiveCountry === "IN" && !(typeof params.taxId === "string" && params.taxId.trim())) {
      const stateCode = params.stateCode === null || params.stateCode === "" ? null : normalizeStateCode(params.stateCode);
      if (params.stateCode !== null && params.stateCode !== "" && !stateCode) {
        throw httpError(400, "stateCode must be a valid GST state code (for example 27 for Maharashtra)");
      }
      // With a GSTIN on file the state must stay the GSTIN's state.
      const gstinOnFile = params.taxId === undefined ? current.taxId : null;
      const gstinState = gstinOnFile ? stateCodeFromGstin(gstinOnFile) : null;
      if (gstinState && stateCode !== gstinState) {
        throw httpError(400, "The state must match the GSTIN on your billing details. Remove or change the GSTIN first.");
      }
      set("billing_state_code", stateCode);
    }

    if (params.name !== undefined) {
      const name = typeof params.name === "string" ? params.name.trim() : "";
      if (name.length > 200) throw httpError(400, "Billing name must be 200 characters or fewer");
      set("billing_name", name || null);
    }

    if (params.address !== undefined) {
      if (params.address !== null && (typeof params.address !== "object" || Array.isArray(params.address))) {
        throw httpError(400, "address must be an object");
      }
      const input = (params.address ?? {}) as Record<string, unknown>;
      const address: Record<string, string> = {};
      for (const field of ADDRESS_FIELDS) {
        const value = input[field];
        if (value === undefined || value === null || value === "") continue;
        if (typeof value !== "string" || value.length > 200) {
          throw httpError(400, `address.${field} must be text of 200 characters or fewer`);
        }
        address[field] = value.trim();
      }
      set("billing_address", Object.keys(address).length > 0 ? JSON.stringify(address) : null);
    }

    if (updates.length > 0) {
      values.push(params.tenantId);
      await query(`UPDATE tenants SET ${updates.join(", ")}, updated_at = now() WHERE id = $${values.length}`, values);
      await AuditService.record({
        tenantId: params.tenantId,
        userId: params.actorId,
        userEmail: params.actorEmail,
        action: "billing.profile.update",
        resourceType: "tenant",
        resourceId: params.tenantId,
        // Field names only: the values (tax id, address) are personal data and stay out of the audit log.
        details: { fields: updates.map((u) => u.split(" = ")[0]) },
        ipAddress: params.ipAddress,
      });
    }

    return this.getBillingProfile(params.tenantId);
  }

  /**
   * Retrieves live usage consumption vs allocated plan quotas for a workspace.
   */
  public static async getUsageAndQuotas(tenantId: string): Promise<WorkspaceUsageSummary> {
    const billing = await this.getBillingProfile(tenantId);

    // 1. Fetch tenant metadata
    const tenant = await queryOne<{
      id: string;
      name: string;
      plan: string;
      plan_status: string;
      plan_expires_at: string | null;
      max_channels: number;
      max_contacts: number;
      max_monthly_messages: number;
      max_monthly_ai_queries: number;
    }>(
      `SELECT id, name, plan, plan_status, plan_expires_at, max_channels, max_contacts, max_monthly_messages, max_monthly_ai_queries
       FROM tenants
       WHERE id = $1`,
      [tenantId]
    );

    if (!tenant) {
      throw new Error("Tenant workspace not found");
    }

    // 2. Load dynamic plans from platform_plans table
    let dbPlans: PlanConfig[] = [];
    try {
      const platformPlans = await listPlatformPlans({ publicOnly: true });
      if (platformPlans && platformPlans.length > 0) {
        dbPlans = platformPlans.map((p) => toPlanConfig(p, billing.currency));
      }
    } catch (err: any) {
      log.warn("Failed to fetch platform plans from DB, using fallback", { error: err.message });
    }

    if (dbPlans.length === 0) {
      dbPlans = Object.values(PLAN_TIERS).map((p) => ({ ...p, currency: billing.currency }));
    }

    const currentPlanKey = (tenant.plan || tenant.plan_status || "pro").toLowerCase();
    const dynamicActivePlan = dbPlans.find((p) => p.id.toLowerCase() === currentPlanKey);
    const activePlan = dynamicActivePlan || PLAN_TIERS[currentPlanKey] || PLAN_TIERS.pro;

    const maxChannels = tenant.max_channels || activePlan.maxChannels;
    const maxContacts = tenant.max_contacts || activePlan.maxContacts;
    const maxMessages = tenant.max_monthly_messages || activePlan.maxMonthlyMessages;
    const maxAiQueries = tenant.max_monthly_ai_queries || activePlan.maxMonthlyAiQueries;

    // 3. Query Postgres Relational counts
    const [channelsCountRes, contactsCountRes, dealsStatsRes, usersCountRes, aiLogsRes, convsRes] =
      await Promise.all([
        queryOne<{ count: string }>(
          "SELECT count(*) as count FROM channels WHERE tenant_id = $1 AND status = 'active'",
          [tenantId]
        ),
        queryOne<{ count: string }>(
          "SELECT count(*) as count FROM contacts WHERE tenant_id = $1",
          [tenantId]
        ),
        queryOne<{ count: string; total_value: string }>(
          "SELECT count(*) as count, coalesce(sum(value), 0) as total_value FROM deals WHERE tenant_id = $1",
          [tenantId]
        ),
        queryOne<{ count: string }>(
          "SELECT count(*) as count FROM users WHERE tenant_id = $1 AND status = 'active'",
          [tenantId]
        ),
        queryOne<{ count: string }>(
          "SELECT count(*) as count FROM ai_logs WHERE tenant_id = $1 AND created_at >= date_trunc('month', now())",
          [tenantId]
        ),
        queryOne<{ count: string }>(
          "SELECT count(*) as count FROM conversations WHERE tenant_id = $1",
          [tenantId]
        ),
      ]);

    const activeChannels = parseInt(channelsCountRes?.count || "0", 10);
    const totalContacts = parseInt(contactsCountRes?.count || "0", 10);
    const dealsCount = parseInt(dealsStatsRes?.count || "0", 10);
    const dealsValue = parseFloat(dealsStatsRes?.total_value || "0");
    const activeUsers = parseInt(usersCountRes?.count || "0", 10);
    const aiQueries = parseInt(aiLogsRes?.count || "0", 10);
    const totalConvs = parseInt(convsRes?.count || "0", 10);

    // 4. Query MongoDB message counts for current month
    let monthlyMessagesCount = 0;
    try {
      const mongo = await getMongoDb();
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      monthlyMessagesCount = await mongo.collection("messages").countDocuments({
        $and: [
          { $or: [{ tenantId }, { tenant_id: tenantId }] },
          { $or: [{ sentAt: { $gte: startOfMonth } }, { createdAt: { $gte: startOfMonth.toISOString() } }] },
        ],
      });
    } catch (err: any) {
      log.warn("Mongo count error (using estimate)", { error: err.message });
      monthlyMessagesCount = Math.max(0, totalConvs * 4);
    }

    // Helper for metric calculations
    const calcMetric = (used: number, limit: number, unit: string): UsageMetric => {
      if (limit === UNLIMITED) return { used, limit, percentage: 0, unit };
      const safeLimit = Math.max(limit, 1);
      const percentage = Math.min(Math.round((used / safeLimit) * 100), 100);
      return { used, limit, percentage, unit };
    };

    // Calculate billing cycle end date (end of current calendar month or plan_expires_at)
    let cycleEndIso = tenant.plan_expires_at;
    if (!cycleEndIso) {
      const cycleEnd = new Date();
      cycleEnd.setMonth(cycleEnd.getMonth() + 1, 0);
      cycleEnd.setHours(23, 59, 59, 999);
      cycleEndIso = cycleEnd.toISOString();
    }

    return {
      tenantId: tenant.id,
      tenantName: tenant.name,
      planId: activePlan.id,
      planName: activePlan.name,
      planStatus: tenant.plan_status || "active",
      planExpiresAt: tenant.plan_expires_at,
      billingCycleEnd: cycleEndIso,
      billingCountry: billing.country,
      billingCurrency: billing.currency,
      currencyLocked: billing.currencyLocked,
      tax: (() => {
        const sample = computeTax(100, billing.currency, billing.country);
        return { ratePercent: sample.taxRate, label: sample.taxLabel };
      })(),
      features: (await getEntitlements(tenantId))?.features ?? ALL_FEATURES_ON,
      enforcement: enforcementMode(),
      metrics: {
        channels: calcMetric(activeChannels, maxChannels, "channels"),
        contacts: calcMetric(totalContacts, maxContacts, "contacts"),
        monthlyMessages: calcMetric(monthlyMessagesCount, maxMessages, "messages"),
        monthlyAiQueries: calcMetric(aiQueries, maxAiQueries, "queries"),
      },
      stats: {
        totalConversations: totalConvs,
        totalDealsCount: dealsCount,
        totalDealsValue: dealsValue,
        activeAgentsCount: activeUsers,
      },
      availablePlans: dbPlans,
    };
  }

  /**
   * What an upgrade would cost RIGHT NOW, shown before the customer pays: the new plan with GST, the credit for the
   * unused time of the current plan, and what is left to pay. The checkout computes the same numbers again and fixes
   * them, so this is a preview, never a promise.
   */
  public static async getUpgradeQuote(tenantId: string, planId: string, billingCycle: "monthly" | "yearly") {
    const billing = await this.getBillingProfile(tenantId);
    const plan = await this.resolvePlan(planId, billing.currency);
    if (!plan) throw httpError(404, `Plan '${planId}' was not found.`);
    if (!plan.priceAvailable) throw httpError(400, `The ${plan.name} plan has no ${billing.currency} price yet.`);

    const monthly = plan.priceMonthly || 0;
    const subtotal = billingCycle === "yearly" ? (plan.priceYearly ?? monthly * 10) : monthly;
    const tax = computeTax(subtotal, billing.currency, billing.country, {
      buyerStateCode: billing.stateCode,
      sellerStateCode: sellerDetails().stateCode,
      buyerTaxId: billing.taxId,
    });
    const assessment = await assessUpgrade({
      tenantId,
      newPlanId: plan.id,
      newBillingCycle: billingCycle,
      newSubtotal: tax.subtotal,
      newTotal: tax.total,
      currency: billing.currency,
    });
    const credit = assessment.kind === "credit" ? assessment.credit : null;
    const payable = Math.round((tax.total - (credit?.total ?? 0)) * 100) / 100;
    return {
      currency: billing.currency,
      planId: plan.id,
      planName: plan.name,
      billingCycle,
      subtotal: tax.subtotal,
      taxAmount: tax.taxAmount,
      taxRate: tax.taxRate,
      taxLabel: tax.taxLabel,
      /** The full invoice for the new plan. */
      invoiceTotal: tax.total,
      credit,
      /** What is charged now. */
      payable,
      /** Why the change is not possible right now (null when it is). */
      blocked: assessment.kind === "blocked" ? { reason: assessment.reason, message: assessment.message, activeUntil: assessment.activeUntil } : null,
    };
  }

  /**
   * Resolves a plan from the database, priced in `currency`. There is deliberately no static fallback:
   * a plan that is not in the database must never be purchasable (or activated for free).
   */
  public static async resolvePlan(
    planId: string,
    currency: BillingCurrency = DEFAULT_BILLING_CURRENCY
  ): Promise<PlanConfig | null> {
    try {
      const dbPlan = await getPlatformPlanById(planId);
      return dbPlan ? toPlanConfig(dbPlan, currency) : null;
    } catch (err: any) {
      log.warn("Failed resolving plan from DB", { planId, error: err.message });
      return null;
    }
  }

  /**
   * The gateway is decided here, never by the browser: the workspace's currency picks Razorpay or Stripe.
   * With BILLING_SANDBOX=true (development only, refused in production) every paid checkout uses the simulated
   * gateway instead, so the whole flow can be tried without payment-provider keys.
   */
  private static pickGateway(currency: BillingCurrency): "stripe" | "razorpay" | "sandbox" {
    if (sandboxEnabled()) return "sandbox";
    return gatewayForCurrency(currency);
  }

  /**
   * Starts a plan purchase. The price (in the workspace's currency, plus GST for India) and the gateway are
   * decided here on the server; the browser only says which plan and billing cycle it wants.
   * A free plan is activated immediately; a paid one returns a gateway URL, and the plan only changes once
   * the provider confirms the payment (webhook or `getCheckoutStatus`).
   */
  public static async createCheckoutSession(params: CreateCheckoutSessionParams): Promise<CheckoutSessionResult> {
    const { tenantId, actorId, actorEmail, planId, billingCycle = "monthly", autoRenew = false } = params;

    const billing = await this.getBillingProfile(tenantId);
    const currency = billing.currency;
    const plan = await this.resolvePlan(planId, currency);
    if (!plan) {
      throw httpError(404, `Plan '${planId}' was not found.`);
    }
    if (!plan.priceAvailable) {
      throw httpError(400, `The ${plan.name} plan has no ${currency} price yet. Please contact support.`);
    }

    const monthly = plan.priceMonthly || 0;
    const subtotal = billingCycle === "yearly" ? (plan.priceYearly ?? monthly * 10) : monthly;

    if (subtotal <= 0) {
      const activated = await recordSubscriptionPayment({
        tenantId,
        planId: plan.id,
        amount: 0,
        currency,
        billingCycle,
        paymentMethod: "free_tier",
        gateway: "free",
        transactionReference: `free_${uuidv4().substring(0, 8)}`,
        notes: `Free plan activated by ${actorEmail || actorId}`,
        sendReceiptEmail: false,
      });
      return {
        sessionId: `free_act_${uuidv4().substring(0, 8)}`,
        gateway: "free",
        planId: plan.id,
        planName: plan.name,
        billingCycle,
        currency,
        subtotal: 0,
        taxAmount: 0,
        taxRate: 0,
        taxLabel: null,
        amount: 0,
        invoiceTotal: 0,
        credit: null,
        autoRenew: false,
        isFree: true,
        isSandbox: false,
        notes: "Free plan activated immediately without charge.",
        activated,
      };
    }

    const result = await startPaidCheckout({
      tenantId,
      actorId,
      actorEmail,
      plan,
      billingCycle,
      billing,
      gateway: this.pickGateway(currency),
      autoRenew,
    });
    return { ...result, planName: plan.name };
  }

  /** Where a checkout stands; asks the provider and activates the plan if it was paid. Tenant-scoped. */
  public static getCheckoutStatus(tenantId: string, ref: string) {
    return getCheckoutStatus(tenantId, ref);
  }

  /**
   * Direct plan update for internal/free adjustments.
   */
  public static async updatePlan(params: {
    tenantId: string;
    actorId?: string;
    actorEmail?: string;
    planId: string;
    ipAddress?: string;
  }): Promise<{ message: string; plan: PlanConfig }> {
    const billing = await this.getBillingProfile(params.tenantId);
    const targetPlan = await this.resolvePlan(params.planId, billing.currency);
    if (!targetPlan) {
      throw httpError(404, `Invalid plan tier: ${params.planId}`);
    }
    // Moving to a paid plan without paying is exactly what checkout exists to prevent.
    if (!targetPlan.priceAvailable || targetPlan.priceMonthly > 0 || (targetPlan.priceYearly ?? 0) > 0) {
      throw httpError(403, "Paid plans are bought through checkout.");
    }

    await query(
      `UPDATE tenants
       SET plan = $1,
           plan_status = 'active',
           max_channels = $2,
           max_contacts = $3,
           max_monthly_messages = $4,
           max_monthly_ai_queries = $5,
           updated_at = now()
       WHERE id = $6`,
      [
        targetPlan.id,
        targetPlan.maxChannels,
        targetPlan.maxContacts,
        targetPlan.maxMonthlyMessages,
        targetPlan.maxMonthlyAiQueries,
        params.tenantId,
      ]
    );
    invalidateEntitlements(params.tenantId);

    // Audit log
    await AuditService.record({
      tenantId: params.tenantId,
      userId: params.actorId,
      userEmail: params.actorEmail,
      action: "plan.upgrade",
      resourceType: "plan",
      resourceId: targetPlan.id,
      details: { planName: targetPlan.name, priceMonthly: targetPlan.priceMonthly },
      ipAddress: params.ipAddress,
    });

    log.info("Upgraded workspace plan tier directly", { tenantId: params.tenantId, plan: targetPlan.id });

    return {
      message: `Workspace successfully switched to ${targetPlan.name}`,
      plan: targetPlan,
    };
  }

  /**
   * Retrieves payment invoices and receipt ledger history for a tenant workspace.
   */
  public static async getInvoices(tenantId: string): Promise<SubscriptionPaymentRecord[]> {
    const result = await listSubscriptionPayments({ tenantId, limit: 50 });
    return result.payments;
  }
}
