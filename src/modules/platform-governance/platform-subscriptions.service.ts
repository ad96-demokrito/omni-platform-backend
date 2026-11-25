import { invalidateEntitlements } from "../billing/plan-limits.service";
import { query, queryOne, withTransaction } from "../../db/pool";
import { getPlatformPlanById } from "./platform-plans.service";
import { currencyForCountry, isSupportedCurrency, normalizeCountryCode } from "../billing/currency";
import { sellerDetails } from "../billing/config";
import { mapPaymentRow, SubscriptionPaymentRecord } from "../billing/payment-record";
import { isSameState, splitTaxAmount } from "../billing/gst";
import { stateName } from "../billing/gst-states";
import { allocateDocumentNumber, indiaMonthRange } from "../billing/invoice-number";
import { startCreditNoteFollowUp, startInvoiceFollowUp } from "../billing/invoice-delivery.service";
import { issueCreditNote } from "../billing/credit-notes.service";
import { randomBytes } from "crypto";
import { logger } from "../../utils/logger";

export interface WorkspaceSubscriptionItem {
  tenantId: string;
  tenantName: string;
  planId: string;
  planName: string;
  planStatus: "active" | "trial" | "suspended" | "cancelled" | "expired" | string;
  planExpiresAt: string | null;
  daysRemaining: number | null;
  isExpired: boolean;
  maxChannels: number;
  activeChannels: number;
  maxContacts: number;
  totalContacts: number;
  maxMonthlyMessages: number;
  maxMonthlyAiQueries: number;
  ownerEmail: string | null;
  ownerName: string | null;
  lastPaymentAt: string | null;
  lastInvoiceNumber: string | null;
  /** Currency this workspace is billed in (decides the plan price and the gateway). */
  billingCurrency: string;
  billingCountry: string | null;
  /** The workspace's auto-renewing subscription: null when it has none (a prepaid plan just ends on its date). */
  renewal: { status: "active" | "past_due"; cancelAtPeriodEnd: boolean; gateway: string } | null;
  createdAt: string;
}

export { mapPaymentRow };
export type { SubscriptionPaymentRecord };

export async function listWorkspaceSubscriptions(filters: {
  search?: string;
  status?: string;
  planId?: string;
  page?: number;
  limit?: number;
} = {}): Promise<{
  subscriptions: WorkspaceSubscriptionItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}> {
  const page = Math.max(1, filters.page || 1);
  const limit = Math.min(100, Math.max(1, filters.limit || 20));
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters.search && filters.search.trim()) {
    conditions.push(`(t.name ILIKE $${idx} OR t.id::text ILIKE $${idx})`);
    params.push(`%${filters.search.trim()}%`);
    idx++;
  }

  if (filters.status && filters.status !== "all") {
    conditions.push(`t.plan_status = $${idx}`);
    params.push(filters.status);
    idx++;
  }

  if (filters.planId && filters.planId !== "all") {
    conditions.push(`(t.plan = $${idx} OR pp.id = $${idx})`);
    params.push(filters.planId);
    idx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRes = await queryOne<{ count: string }>(
    `SELECT count(*) FROM tenants t LEFT JOIN platform_plans pp ON pp.id = t.plan ${whereClause}`,
    params
  );
  const total = parseInt(countRes?.count || "0", 10);

  const sql = `
    SELECT
      t.id,
      t.name,
      t.plan,
      t.plan_status,
      t.plan_expires_at,
      t.max_channels,
      t.max_contacts,
      t.max_monthly_messages,
      t.max_monthly_ai_queries,
      t.billing_country,
      t.billing_currency,
      t.created_at,
      COALESCE(pp.name, initcap(t.plan)) as resolved_plan_name,
      (SELECT s.status FROM tenant_subscriptions s WHERE s.tenant_id = t.id AND s.status IN ('active', 'past_due') ORDER BY s.created_at DESC LIMIT 1) as renewal_status,
      (SELECT s.cancel_at_period_end FROM tenant_subscriptions s WHERE s.tenant_id = t.id AND s.status IN ('active', 'past_due') ORDER BY s.created_at DESC LIMIT 1) as renewal_cancelled,
      (SELECT s.gateway FROM tenant_subscriptions s WHERE s.tenant_id = t.id AND s.status IN ('active', 'past_due') ORDER BY s.created_at DESC LIMIT 1) as renewal_gateway,
      (SELECT count(*) FROM channels c WHERE c.tenant_id = t.id AND c.status = 'active') as active_channels,
      (SELECT count(*) FROM contacts ct WHERE ct.tenant_id = t.id) as total_contacts,
      (SELECT u.email FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner' LIMIT 1) as owner_email,
      (SELECT u.name FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner' LIMIT 1) as owner_name,
      (SELECT psp.created_at FROM platform_subscription_payments psp WHERE psp.tenant_id = t.id ORDER BY psp.created_at DESC LIMIT 1) as last_payment_at,
      (SELECT psp.invoice_number FROM platform_subscription_payments psp WHERE psp.tenant_id = t.id ORDER BY psp.created_at DESC LIMIT 1) as last_invoice_number
    FROM tenants t
    LEFT JOIN platform_plans pp ON pp.id = t.plan
    ${whereClause}
    ORDER BY t.created_at DESC
    LIMIT $${idx} OFFSET $${idx + 1}
  `;

  params.push(limit, offset);
  const rows = await query<any>(sql, params);

  const now = new Date();
  const subscriptions: WorkspaceSubscriptionItem[] = rows.map((r) => {
    let daysRemaining: number | null = null;
    let isExpired = false;

    if (r.plan_expires_at) {
      const expiry = new Date(r.plan_expires_at);
      const diffMs = expiry.getTime() - now.getTime();
      daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      if (daysRemaining < 0) {
        isExpired = true;
      }
    }

    return {
      tenantId: r.id,
      tenantName: r.name,
      planId: r.plan,
      planName: r.resolved_plan_name || r.plan,
      planStatus: r.plan_status || "active",
      planExpiresAt: r.plan_expires_at,
      daysRemaining,
      isExpired,
      maxChannels: parseInt(r.max_channels || "1", 10),
      activeChannels: parseInt(r.active_channels || "0", 10),
      maxContacts: parseInt(r.max_contacts || "500", 10),
      totalContacts: parseInt(r.total_contacts || "0", 10),
      maxMonthlyMessages: parseInt(r.max_monthly_messages || "2000", 10),
      maxMonthlyAiQueries: parseInt(r.max_monthly_ai_queries || "100", 10),
      ownerEmail: r.owner_email,
      ownerName: r.owner_name,
      lastPaymentAt: r.last_payment_at,
      lastInvoiceNumber: r.last_invoice_number,
      billingCurrency: (r.billing_currency || "USD").trim().toUpperCase(),
      billingCountry: r.billing_country ? r.billing_country.trim() : null,
      renewal: r.renewal_status
        ? { status: r.renewal_status, cancelAtPeriodEnd: Boolean(r.renewal_cancelled), gateway: r.renewal_gateway }
        : null,
      createdAt: r.created_at,
    };
  });

  return {
    subscriptions,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

export async function updateTenantSubscriptionLifecycle(params: {
  tenantId: string;
  planId?: string;
  planStatus?: "active" | "trial" | "suspended" | "cancelled" | "expired" | string;
  planExpiresAt?: string | null;
  maxChannels?: number;
  maxContacts?: number;
  maxMonthlyMessages?: number;
  maxMonthlyAiQueries?: number;
}): Promise<WorkspaceSubscriptionItem> {
  const { tenantId, planId, planStatus, planExpiresAt, maxChannels, maxContacts, maxMonthlyMessages, maxMonthlyAiQueries } = params;

  const tenant = await queryOne<any>("SELECT id, name, plan, plan_status FROM tenants WHERE id = $1", [tenantId]);
  if (!tenant) throw new Error("Tenant workspace not found");

  const updates: string[] = ["updated_at = now()"];
  const values: any[] = [];
  let idx = 1;

  if (planId !== undefined) {
    updates.push(`plan = $${idx++}`);
    values.push(planId.toLowerCase());

    // If changing plan and specific quotas were not overridden, sync quotas from platform_plans
    const planConfig = await getPlatformPlanById(planId);
    if (planConfig) {
      if (maxChannels === undefined) {
        updates.push(`max_channels = $${idx++}`);
        values.push(planConfig.maxChannels);
      }
      if (maxContacts === undefined) {
        updates.push(`max_contacts = $${idx++}`);
        values.push(planConfig.maxContacts);
      }
      if (maxMonthlyMessages === undefined) {
        updates.push(`max_monthly_messages = $${idx++}`);
        values.push(planConfig.maxMonthlyMessages);
      }
      if (maxMonthlyAiQueries === undefined) {
        updates.push(`max_monthly_ai_queries = $${idx++}`);
        values.push(planConfig.maxMonthlyAiQueries);
      }
    }
  }

  if (planStatus !== undefined) {
    updates.push(`plan_status = $${idx++}`);
    values.push(planStatus);
  }

  if (planExpiresAt !== undefined) {
    updates.push(`plan_expires_at = $${idx++}`);
    values.push(planExpiresAt);
  }

  if (maxChannels !== undefined) {
    updates.push(`max_channels = $${idx++}`);
    values.push(Math.max(1, maxChannels));
  }
  if (maxContacts !== undefined) {
    updates.push(`max_contacts = $${idx++}`);
    values.push(Math.max(10, maxContacts));
  }
  if (maxMonthlyMessages !== undefined) {
    updates.push(`max_monthly_messages = $${idx++}`);
    values.push(Math.max(100, maxMonthlyMessages));
  }
  if (maxMonthlyAiQueries !== undefined) {
    updates.push(`max_monthly_ai_queries = $${idx++}`);
    values.push(Math.max(0, maxMonthlyAiQueries));
  }

  values.push(tenantId);
  const sql = `UPDATE tenants SET ${updates.join(", ")} WHERE id = $${idx}`;
  await query(sql, values);
  invalidateEntitlements(tenantId);

  const res = await listWorkspaceSubscriptions({ search: tenantId, limit: 1 });
  if (res.subscriptions.length === 0) throw new Error("Failed to retrieve updated subscription");
  return res.subscriptions[0];
}

/**
 * Platform-staff override of a workspace's billing country (and so its currency), including after the
 * currency was locked by the first paid payment. `resetLock` lets the customer change it themselves again.
 */
export async function setWorkspaceBillingCountry(
  tenantId: string,
  countryInput: unknown,
  resetLock: boolean
): Promise<{ billingCountry: string; billingCurrency: string; currencyLocked: boolean }> {
  const country = normalizeCountryCode(countryInput);
  if (!country) throw new Error("country must be a 2-letter ISO country code (for example IN or US)");
  const currency = currencyForCountry(country);

  const row = await queryOne<{ currency_locked_at: string | null }>(
    `UPDATE tenants
     SET billing_country = $2, billing_currency = $3,
         currency_locked_at = CASE WHEN $4::boolean THEN NULL ELSE currency_locked_at END,
         updated_at = now()
     WHERE id = $1
     RETURNING currency_locked_at`,
    [tenantId, country, currency, resetLock]
  );
  if (!row) throw new Error("Tenant workspace not found");
  return { billingCountry: country, billingCurrency: currency, currencyLocked: Boolean(row.currency_locked_at) };
}

/** The buyer's address as one printable line, from the billing address the customer entered. */
function formatBuyerAddress(address: Record<string, string> | null, country: string | null): string | null {
  const parts = ["line1", "line2", "city", "state", "postalCode"].map((key) => address?.[key]?.trim()).filter(Boolean);
  if (country) parts.push(country.trim());
  return parts.length > 0 ? parts.join(", ") : null;
}

export async function recordSubscriptionPayment(params: {
  tenantId: string;
  planId: string;
  amount: number;
  currency?: string;
  billingCycle?: "monthly" | "yearly" | "custom" | string;
  paymentMethod?: string;
  transactionReference?: string;
  periodStart?: string;
  periodEnd?: string;
  durationDays?: number;
  notes?: string;
  sendReceiptEmail?: boolean;
  staffId?: string;
  staffName?: string;
  /** Which provider collected it ("stripe", "razorpay", "sandbox") and its id for the payment. */
  gateway?: string;
  gatewayPaymentId?: string;
  /** Tax split of `amount` (the total). Without these the whole amount is the subtotal. */
  taxAmount?: number;
  taxRate?: number;
  taxLabel?: string | null;
  buyerTaxId?: string | null;
  sellerTaxId?: string | null;
  /**
   * An upgrade: credit the unused part of an earlier invoice. A credit note is issued in the same transaction as this
   * invoice and applied to it, so `amount` stays the full invoice value and the cash collected is amount - credit.
   */
  credit?: { invoiceId: string; subtotal: number; tax: number; total: number };
}): Promise<{ payment: SubscriptionPaymentRecord; subscription: WorkspaceSubscriptionItem }> {
  const {
    tenantId,
    planId,
    amount,
    currency: requestedCurrency,
    billingCycle = "monthly",
    paymentMethod = "stripe",
    transactionReference,
    notes,
    sendReceiptEmail = true,
    staffId,
    staffName,
    gateway,
    gatewayPaymentId,
    taxAmount = 0,
    taxRate = 0,
    taxLabel = null,
  } = params;
  const subtotal = Math.round((Number(amount) - taxAmount) * 100) / 100;

  const tenant = await queryOne<any>(
    `SELECT id, name, plan, plan_expires_at, billing_currency, billing_country, billing_name, billing_address,
            billing_tax_id, billing_state_code
     FROM tenants WHERE id = $1`,
    [tenantId]
  );
  if (!tenant) throw new Error("Tenant workspace not found");

  // A payment is recorded in the currency it was made in; when the caller does not say, that is the
  // workspace's billing currency (never a hard-coded USD).
  const currency = String(requestedCurrency || tenant.billing_currency || "USD").trim().toUpperCase();
  if (!isSupportedCurrency(currency)) {
    throw new Error(`Unsupported currency '${currency}'. Supported: INR, USD.`);
  }

  const plan = await getPlatformPlanById(planId);
  const planName = plan ? plan.name : planId.toUpperCase();

  const periodStartDate = params.periodStart ? new Date(params.periodStart) : new Date();
  let periodEndDate: Date;

  if (params.periodEnd) {
    periodEndDate = new Date(params.periodEnd);
  } else if (params.durationDays) {
    periodEndDate = new Date(periodStartDate.getTime() + params.durationDays * 24 * 60 * 60 * 1000);
  } else if (billingCycle === "yearly") {
    periodEndDate = new Date(periodStartDate);
    periodEndDate.setFullYear(periodEndDate.getFullYear() + 1);
  } else {
    // default 1 month
    periodEndDate = new Date(periodStartDate);
    periodEndDate.setMonth(periodEndDate.getMonth() + 1);
  }

  // Seller and buyer are frozen into the invoice now: later edits to the workspace's profile or to our own
  // settings must never change an invoice that was already issued.
  const seller = sellerDetails();
  const buyerCountry = tenant.billing_country ? String(tenant.billing_country).trim().toUpperCase() : null;
  const isIndian = currency === "INR" && buyerCountry === "IN";
  const buyerTaxId = params.buyerTaxId !== undefined ? params.buyerTaxId : tenant.billing_tax_id ?? null;
  const sellerTaxId = params.sellerTaxId ?? seller.taxId;
  const supplyType = !isIndian ? "export" : buyerTaxId ? "b2b" : "b2c";
  const buyerStateCode = isIndian && tenant.billing_state_code ? String(tenant.billing_state_code).trim() : null;
  const taxSplit = splitTaxAmount(taxAmount, currency, isSameState(buyerStateCode, seller.stateCode));
  const placeOfSupply = isIndian ? stateName(buyerStateCode) : `Outside India${buyerCountry ? ` (${buyerCountry})` : ""}`;
  const issuedAt = new Date();
  // A zero-amount record (switching to a free plan, a complimentary grant) is not a tax invoice: it must not use up
  // a number of the gapless series, carries no tax snapshot and is never emailed.
  const isFreeRecord = Number(amount) <= 0;

  // The number and the row are written in ONE transaction: if the insert fails the number is handed out again,
  // so there are no gaps in the series (a CA and the GST rules both expect that).
  let creditNoteId: string | null = null;
  const paymentRow = await withTransaction(async (client) => {
    const invoiceNumber = isFreeRecord
      ? `FREE/${randomBytes(4).toString("hex").toUpperCase()}`
      : await allocateDocumentNumber(client, "invoice", issuedAt);
    const inserted = await client.query(
      `INSERT INTO platform_subscription_payments (
         tenant_id, plan_id, plan_name, amount, currency, billing_cycle,
         payment_method, transaction_reference, status, invoice_number,
         period_start, period_end, notes, recorded_by_staff_id, recorded_by_name,
         gateway, gateway_payment_id, subtotal, tax_amount, tax_rate, tax_label, buyer_tax_id, seller_tax_id,
         seller_name, seller_address, seller_state_code, buyer_name, buyer_address, buyer_state_code,
         place_of_supply, sac_code, cgst_amount, sgst_amount, igst_amount, supply_type, lut_number, issued_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'paid', $9, $10, $11, $12, $13, $14,
                 $15, $16, $17, $18, $19, $20, $21, $22,
                 $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36)
       RETURNING *`,
      [
        tenantId,
        planId.toLowerCase(),
        planName,
        amount,
        currency.toUpperCase(),
        billingCycle,
        paymentMethod,
        transactionReference || null,
        invoiceNumber,
        periodStartDate.toISOString(),
        periodEndDate.toISOString(),
        notes || null,
        staffId || null,
        staffName || null,
        gateway || null,
        gatewayPaymentId || null,
        subtotal,
        taxAmount,
        taxRate,
        taxLabel,
        buyerTaxId,
        sellerTaxId,
        isFreeRecord ? null : seller.legalName,
        isFreeRecord ? null : seller.address,
        isFreeRecord ? null : seller.stateCode,
        isFreeRecord ? null : tenant.billing_name || tenant.name,
        isFreeRecord ? null : formatBuyerAddress(tenant.billing_address ?? null, buyerCountry),
        isFreeRecord ? null : buyerStateCode,
        isFreeRecord ? null : placeOfSupply,
        isFreeRecord ? null : seller.sacCode,
        taxSplit.cgst,
        taxSplit.sgst,
        taxSplit.igst,
        isFreeRecord ? null : supplyType,
        !isFreeRecord && supplyType === "export" ? seller.lutNumber : null,
        issuedAt.toISOString(),
      ]
    );
    const created = inserted.rows[0];
    if (params.credit && !isFreeRecord) {
      creditNoteId = await issueCreditNote(client, {
        invoiceId: params.credit.invoiceId,
        tenantId,
        kind: "upgrade_credit",
        reason: `Upgrade to the ${planName} plan: unused time of the previous plan`,
        total: params.credit.total,
        split: { subtotal: params.credit.subtotal, tax: params.credit.tax },
        appliedToInvoiceId: created.id,
        issuedBy: staffName ? `staff:${staffName}` : "system",
        issuedAt,
      });
      const withCredit = await client.query(
        "UPDATE platform_subscription_payments SET credit_applied = $2 WHERE id = $1 RETURNING *",
        [created.id, params.credit.total]
      );
      return withCredit.rows[0];
    }
    return created;
  });
  const invoiceNumber: string = paymentRow.invoice_number;

  // The first paid payment locks the workspace's billing currency (see BillingService.updateBillingProfile).
  if (Number(amount) > 0) {
    await query("UPDATE tenants SET currency_locked_at = COALESCE(currency_locked_at, now()) WHERE id = $1", [tenantId]);
  }

  // Extend tenant subscription & activate
  await updateTenantSubscriptionLifecycle({
    tenantId,
    planId,
    planStatus: "active",
    planExpiresAt: periodEndDate.toISOString(),
    maxChannels: plan?.maxChannels,
    maxContacts: plan?.maxContacts,
    maxMonthlyMessages: plan?.maxMonthlyMessages,
    maxMonthlyAiQueries: plan?.maxMonthlyAiQueries,
  });

  const updatedSub = (await listWorkspaceSubscriptions({ search: tenantId, limit: 1 })).subscriptions[0];

  // The invoice PDF is created and stored, then emailed when INVOICE_EMAIL_ENABLED allows it. Both run in the
  // background and never hold up (or fail) the payment.
  if (!isFreeRecord) {
    startInvoiceFollowUp(paymentRow.id, { email: sendReceiptEmail });
    if (creditNoteId) startCreditNoteFollowUp(creditNoteId, { email: sendReceiptEmail });
  }

  const paymentRecord = mapPaymentRow(paymentRow, tenant.name);

  return { payment: paymentRecord, subscription: updatedSub };
}

export async function listSubscriptionPayments(filters: {
  tenantId?: string;
  status?: string;
  search?: string;
  /** "YYYY-MM" in India time, by invoice issue date (or the record date for legacy rows). */
  month?: string;
  page?: number;
  limit?: number;
} = {}): Promise<{
  payments: SubscriptionPaymentRecord[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  /** Paid revenue per currency. Currencies are never added together. */
  revenueByCurrency: Record<string, number>;
}> {
  const page = Math.max(1, filters.page || 1);
  const limit = Math.min(100, Math.max(1, filters.limit || 20));
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters.tenantId && filters.tenantId !== "all") {
    conditions.push(`psp.tenant_id = $${idx++}`);
    params.push(filters.tenantId);
  }

  if (filters.status && filters.status !== "all") {
    conditions.push(`psp.status = $${idx++}`);
    params.push(filters.status);
  }

  if (filters.month) {
    const range = indiaMonthRange(filters.month);
    if (!range) throw new Error("month must look like 2026-11");
    conditions.push(
      `COALESCE(psp.issued_at, psp.created_at) >= $${idx} AND COALESCE(psp.issued_at, psp.created_at) < $${idx + 1}`
    );
    params.push(range.from.toISOString(), range.to.toISOString());
    idx += 2;
  }

  if (filters.search && filters.search.trim()) {
    conditions.push(`(psp.invoice_number ILIKE $${idx} OR t.name ILIKE $${idx} OR psp.transaction_reference ILIKE $${idx})`);
    params.push(`%${filters.search.trim()}%`);
    idx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const [countRes, revenueRes] = await Promise.all([
    queryOne<{ count: string }>(
      `SELECT count(*) FROM platform_subscription_payments psp JOIN tenants t ON t.id = psp.tenant_id ${whereClause}`,
      params
    ),
    query<{ currency: string; total_revenue: string }>(
      `SELECT psp.currency, coalesce(sum(psp.amount), 0) as total_revenue
       FROM platform_subscription_payments psp JOIN tenants t ON t.id = psp.tenant_id
       ${whereClause ? `${whereClause} AND` : "WHERE"} psp.status = 'paid'
       GROUP BY psp.currency`,
      params
    ),
  ]);

  const total = parseInt(countRes?.count || "0", 10);
  const revenueByCurrency: Record<string, number> = {};
  for (const row of revenueRes) {
    revenueByCurrency[String(row.currency).trim().toUpperCase()] = parseFloat(row.total_revenue || "0");
  }

  const sql = `
    SELECT psp.*, t.name AS tenant_name
    FROM platform_subscription_payments psp
    JOIN tenants t ON t.id = psp.tenant_id
    ${whereClause}
    ORDER BY psp.created_at DESC
    LIMIT $${idx} OFFSET $${idx + 1}
  `;

  params.push(limit, offset);
  const rows = await query<any>(sql, params);

  const payments: SubscriptionPaymentRecord[] = rows.map((r) => mapPaymentRow(r, r.tenant_name));

  return {
    payments,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    revenueByCurrency,
  };
}
