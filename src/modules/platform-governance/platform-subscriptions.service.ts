import { query, queryOne, withTransaction } from "../../db/pool";
import { emailService } from "../email/email.service";
import { getPlatformPlanById } from "./platform-plans.service";
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
  createdAt: string;
}

export interface SubscriptionPaymentRecord {
  id: string;
  tenantId: string;
  tenantName: string;
  planId: string;
  planName: string;
  amount: number;
  currency: string;
  billingCycle: "monthly" | "yearly" | "custom" | string;
  paymentMethod: "stripe" | "razorpay" | "bank_transfer" | "credit_card" | "manual" | "crypto" | string;
  transactionReference: string | null;
  status: "paid" | "pending" | "failed" | "refunded" | string;
  invoiceNumber: string;
  periodStart: string;
  periodEnd: string;
  notes: string | null;
  recordedByStaffId: string | null;
  recordedByName: string | null;
  createdAt: string;
}

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
      t.created_at,
      COALESCE(pp.name, initcap(t.plan)) as resolved_plan_name,
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

  const res = await listWorkspaceSubscriptions({ search: tenantId, limit: 1 });
  if (res.subscriptions.length === 0) throw new Error("Failed to retrieve updated subscription");
  return res.subscriptions[0];
}

export async function generateNextInvoiceNumber(): Promise<string> {
  const dateStr = new Date().toISOString().slice(0, 7).replace("-", ""); // YYYYMM
  const randomSuffix = Math.floor(1000 + Math.random() * 9000);
  const countRes = await queryOne<{ count: string }>(
    `SELECT count(*) FROM platform_subscription_payments WHERE invoice_number LIKE $1`,
    [`INV-${dateStr}-%`]
  );
  const seq = (parseInt(countRes?.count || "0", 10) + 1).toString().padStart(4, "0");
  return `INV-${dateStr}-${seq}-${randomSuffix}`;
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
}): Promise<{ payment: SubscriptionPaymentRecord; subscription: WorkspaceSubscriptionItem }> {
  const {
    tenantId,
    planId,
    amount,
    currency = "INR",
    billingCycle = "monthly",
    paymentMethod = "stripe",
    transactionReference,
    notes,
    sendReceiptEmail = true,
    staffId,
    staffName,
  } = params;

  const tenant = await queryOne<any>("SELECT id, name, plan, plan_expires_at FROM tenants WHERE id = $1", [tenantId]);
  if (!tenant) throw new Error("Tenant workspace not found");

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

  const invoiceNumber = await generateNextInvoiceNumber();

  const paymentRow = await queryOne<any>(
    `INSERT INTO platform_subscription_payments (
       tenant_id, plan_id, plan_name, amount, currency, billing_cycle,
       payment_method, transaction_reference, status, invoice_number,
       period_start, period_end, notes, recorded_by_staff_id, recorded_by_name
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'paid', $9, $10, $11, $12, $13, $14)
     RETURNING id, tenant_id, plan_id, plan_name, amount, currency, billing_cycle,
               payment_method, transaction_reference, status, invoice_number,
               period_start, period_end, notes, recorded_by_staff_id, recorded_by_name, created_at`,
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
    ]
  );

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

  // Optionally send transactional email receipt to tenant owner
  if (sendReceiptEmail && updatedSub?.ownerEmail) {
    emailService
      .sendSubscriptionReceipt({
        to: updatedSub.ownerEmail,
        tenantName: tenant.name,
        planName,
        invoiceNumber,
        amount: Number(amount),
        currency: currency.toUpperCase(),
        billingCycle,
        periodEnd: periodEndDate.toISOString(),
        paymentMethod,
      })
      .catch((err) => {
        logger.error("[SubscriptionPayment] Failed to send receipt email:", err);
      });
  }

  const paymentRecord: SubscriptionPaymentRecord = {
    id: paymentRow.id,
    tenantId: paymentRow.tenant_id,
    tenantName: tenant.name,
    planId: paymentRow.plan_id,
    planName: paymentRow.plan_name,
    amount: parseFloat(paymentRow.amount || "0"),
    currency: paymentRow.currency,
    billingCycle: paymentRow.billing_cycle,
    paymentMethod: paymentRow.payment_method,
    transactionReference: paymentRow.transaction_reference,
    status: paymentRow.status,
    invoiceNumber: paymentRow.invoice_number,
    periodStart: paymentRow.period_start,
    periodEnd: paymentRow.period_end,
    notes: paymentRow.notes,
    recordedByStaffId: paymentRow.recorded_by_staff_id,
    recordedByName: paymentRow.recorded_by_name,
    createdAt: paymentRow.created_at,
  };

  return { payment: paymentRecord, subscription: updatedSub };
}

export async function listSubscriptionPayments(filters: {
  tenantId?: string;
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
} = {}): Promise<{
  payments: SubscriptionPaymentRecord[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  totalRevenue: number;
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
    queryOne<{ total_revenue: string }>(
      `SELECT coalesce(sum(psp.amount), 0) as total_revenue FROM platform_subscription_payments psp JOIN tenants t ON t.id = psp.tenant_id ${whereClause} AND psp.status = 'paid'`,
      params
    ),
  ]);

  const total = parseInt(countRes?.count || "0", 10);
  const totalRevenue = parseFloat(revenueRes?.total_revenue || "0");

  const sql = `
    SELECT
      psp.id,
      psp.tenant_id,
      t.name as tenant_name,
      psp.plan_id,
      psp.plan_name,
      psp.amount,
      psp.currency,
      psp.billing_cycle,
      psp.payment_method,
      psp.transaction_reference,
      psp.status,
      psp.invoice_number,
      psp.period_start,
      psp.period_end,
      psp.notes,
      psp.recorded_by_staff_id,
      psp.recorded_by_name,
      psp.created_at
    FROM platform_subscription_payments psp
    JOIN tenants t ON t.id = psp.tenant_id
    ${whereClause}
    ORDER BY psp.created_at DESC
    LIMIT $${idx} OFFSET $${idx + 1}
  `;

  params.push(limit, offset);
  const rows = await query<any>(sql, params);

  const payments: SubscriptionPaymentRecord[] = rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    tenantName: r.tenant_name,
    planId: r.plan_id,
    planName: r.plan_name,
    amount: parseFloat(r.amount || "0"),
    currency: r.currency,
    billingCycle: r.billing_cycle,
    paymentMethod: r.payment_method,
    transactionReference: r.transaction_reference,
    status: r.status,
    invoiceNumber: r.invoice_number,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    notes: r.notes,
    recordedByStaffId: r.recorded_by_staff_id,
    recordedByName: r.recorded_by_name,
    createdAt: r.created_at,
  }));

  return {
    payments,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    totalRevenue,
  };
}
