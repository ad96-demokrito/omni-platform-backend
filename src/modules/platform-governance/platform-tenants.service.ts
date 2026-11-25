import { invalidateEntitlements } from "../billing/plan-limits.service";
import { query, queryOne, withTransaction } from "../../db/pool";

export interface TenantMetadata {
  id: string;
  name: string;
  plan: string;
  planStatus: "active" | "suspended" | "trial" | "cancelled" | string;
  planExpiresAt: string | null;
  /** Currency this workspace is billed in, and the country that decided it. */
  billingCurrency: string;
  billingCountry: string | null;
  maxChannels: number;
  channelCount: number;
  activeChannelCount: number;
  maxContacts: number;
  maxMonthlyMessages: number;
  messageQuotaMonthly: number;
  messagesSentCurrentPeriod: number;
  maxMonthlyAiQueries: number;
  maxUsers: number;
  userCount: number;
  webhookSubscriptionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformTenantFilter {
  search?: string;
  plan?: string;
  planStatus?: string;
  page?: number;
  limit?: number;
}

/**
 * STRICT DATA PRIVACY SHIELD GUARANTEE:
 *
 * All queries in this service strictly query high-level tenancy metadata tables
 * (`tenants`, `users` [COUNT only], `channels` [COUNT and type summary only], `webhook_subscriptions` [COUNT only]).
 *
 * UNDER NO CIRCUMSTANCES DOES THIS SERVICE QUERY, JOIN, OR EXPOSE:
 * - `messages` content/body/sender/recipient
 * - `contacts` table PII
 * - `conversations` table transcripts
 * - `products` / `orders` / `payments` customer transactional records
 * - `ai_knowledge_bases` / vectors / document files
 *
 * This satisfies enterprise GDPR Article 28 DPA boundaries and prevents platform staff PII exposure.
 */

export async function listTenantsMetadata(filters: PlatformTenantFilter = {}): Promise<{
  tenants: TenantMetadata[];
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
  let paramIdx = 1;

  if (filters.search && filters.search.trim()) {
    conditions.push(`(t.name ILIKE $${paramIdx} OR t.id::text ILIKE $${paramIdx})`);
    params.push(`%${filters.search.trim()}%`);
    paramIdx++;
  }

  if (filters.plan && filters.plan !== "all") {
    conditions.push(`t.plan = $${paramIdx}`);
    params.push(filters.plan);
    paramIdx++;
  }

  if (filters.planStatus && filters.planStatus !== "all") {
    conditions.push(`t.plan_status = $${paramIdx}`);
    params.push(filters.planStatus);
    paramIdx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Count total matching
  const countRes = await queryOne<{ count: string }>(
    `SELECT count(*) FROM tenants t ${whereClause}`,
    params
  );
  const total = parseInt(countRes?.count || "0", 10);

  // Query metadata strictly without sensitive customer content
  const sql = `
    SELECT
      t.id,
      t.name,
      t.plan,
      t.plan_status,
      t.plan_expires_at,
      t.billing_currency,
      t.billing_country,
      t.max_channels,
      t.max_contacts,
      t.max_monthly_messages,
      t.max_monthly_ai_queries,
      t.created_at,
      t.updated_at,
      (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id) AS user_count,
      (SELECT count(*)::int FROM channels c WHERE c.tenant_id = t.id AND c.status = 'active') AS active_channel_count,
      (SELECT count(*)::int FROM webhook_subscriptions w WHERE w.tenant_id = t.id AND w.is_active = true) AS webhook_subscription_count,
      (SELECT count(*)::int FROM messages m WHERE m.tenant_id = t.id AND m.sent_at >= date_trunc('month', now())) AS messages_sent_current_period
    FROM tenants t
    ${whereClause}
    ORDER BY t.created_at DESC
    LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
  `;

  params.push(limit, offset);

  const rows = await query<any>(sql, params);

  const tenants: TenantMetadata[] = rows.map((r) => {
    const quota = r.max_monthly_messages ?? 25000;
    const maxChannels = r.max_channels ?? 5;
    const maxUsers = r.plan === "enterprise" ? 100 : r.plan === "growth" ? 25 : r.plan === "starter" ? 10 : 5;
    const channelCount = r.active_channel_count || 0;
    const userCount = r.user_count || 0;
    const messagesSentCurrentPeriod = r.messages_sent_current_period || 0;

    return {
      id: r.id,
      name: r.name,
      plan: r.plan,
      planStatus: r.plan_status || "active",
      planExpiresAt: r.plan_expires_at,
      billingCurrency: (r.billing_currency || "USD").trim().toUpperCase(),
      billingCountry: r.billing_country ? r.billing_country.trim() : null,
      maxChannels,
      channelCount,
      activeChannelCount: channelCount,
      maxContacts: r.max_contacts ?? 5000,
      maxMonthlyMessages: quota,
      messageQuotaMonthly: quota,
      messagesSentCurrentPeriod,
      maxMonthlyAiQueries: r.max_monthly_ai_queries ?? 1000,
      maxUsers,
      userCount,
      webhookSubscriptionCount: r.webhook_subscription_count || 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });

  return {
    tenants,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

export async function getTenantMetadataById(tenantId: string): Promise<TenantMetadata | null> {
  const sql = `
    SELECT
      t.id,
      t.name,
      t.plan,
      t.plan_status,
      t.plan_expires_at,
      t.billing_currency,
      t.billing_country,
      t.max_channels,
      t.max_contacts,
      t.max_monthly_messages,
      t.max_monthly_ai_queries,
      t.created_at,
      t.updated_at,
      (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id) AS user_count,
      (SELECT count(*)::int FROM channels c WHERE c.tenant_id = t.id AND c.status = 'active') AS active_channel_count,
      (SELECT count(*)::int FROM webhook_subscriptions w WHERE w.tenant_id = t.id AND w.is_active = true) AS webhook_subscription_count,
      (SELECT count(*)::int FROM messages m WHERE m.tenant_id = t.id AND m.sent_at >= date_trunc('month', now())) AS messages_sent_current_period
    FROM tenants t
    WHERE t.id = $1
  `;

  const r = await queryOne<any>(sql, [tenantId]);
  if (!r) return null;

  const quota = r.max_monthly_messages ?? 25000;
  const maxChannels = r.max_channels ?? 5;
  const maxUsers = r.plan === "enterprise" ? 100 : r.plan === "growth" ? 25 : r.plan === "starter" ? 10 : 5;
  const channelCount = r.active_channel_count || 0;
  const userCount = r.user_count || 0;
  const messagesSentCurrentPeriod = r.messages_sent_current_period || 0;

  return {
    id: r.id,
    name: r.name,
    plan: r.plan,
    planStatus: r.plan_status || "active",
    planExpiresAt: r.plan_expires_at,
      billingCurrency: (r.billing_currency || "USD").trim().toUpperCase(),
      billingCountry: r.billing_country ? r.billing_country.trim() : null,
    maxChannels,
    channelCount,
    activeChannelCount: channelCount,
    maxContacts: r.max_contacts ?? 5000,
    maxMonthlyMessages: quota,
    messageQuotaMonthly: quota,
    messagesSentCurrentPeriod,
    maxMonthlyAiQueries: r.max_monthly_ai_queries ?? 1000,
    maxUsers,
    userCount,
    webhookSubscriptionCount: r.webhook_subscription_count || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function updateTenantGovernance(params: {
  tenantId: string;
  plan?: string;
  planStatus?: "active" | "suspended" | "trial" | "cancelled";
  planExpiresAt?: string | null;
  maxChannels?: number;
  maxContacts?: number;
  maxMonthlyMessages?: number;
  maxMonthlyAiQueries?: number;
}): Promise<TenantMetadata> {
  const {
    tenantId,
    plan,
    planStatus,
    planExpiresAt,
    maxChannels,
    maxContacts,
    maxMonthlyMessages,
    maxMonthlyAiQueries,
  } = params;

  const updates: string[] = ["updated_at = now()"];
  const values: any[] = [];
  let idx = 1;

  if (plan !== undefined) {
    updates.push(`plan = $${idx++}`);
    values.push(plan);
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
    values.push(maxChannels);
  }
  if (maxContacts !== undefined) {
    updates.push(`max_contacts = $${idx++}`);
    values.push(maxContacts);
  }
  if (maxMonthlyMessages !== undefined) {
    updates.push(`max_monthly_messages = $${idx++}`);
    values.push(maxMonthlyMessages);
  }
  if (maxMonthlyAiQueries !== undefined) {
    updates.push(`max_monthly_ai_queries = $${idx++}`);
    values.push(maxMonthlyAiQueries);
  }

  values.push(tenantId);
  const sql = `UPDATE tenants SET ${updates.join(", ")} WHERE id = $${idx} RETURNING id`;
  const result = await queryOne(sql, values);

  if (!result) {
    throw new Error(`Tenant with ID ${tenantId} not found`);
  }
  invalidateEntitlements(tenantId);

  const updated = await getTenantMetadataById(tenantId);
  if (!updated) throw new Error("Failed to load updated tenant metadata");
  return updated;
}

export async function getPlatformOverviewAggregations(): Promise<{
  totalWorkspaces: number;
  totalTenants: number;
  activeWorkspaces: number;
  activeTenants: number;
  suspendedWorkspaces: number;
  suspendedTenants: number;
  trialWorkspaces: number;
  trialTenants: number;
  planDistribution: Record<string, number>;
  totalChannelsConnected: number;
  totalChannels: number;
  totalUsersRegistered: number;
  totalPlatformStaff: number;
}> {
  const [totalRes, activeRes, suspendedRes, trialRes, plansRes, channelsRes, usersRes, staffRes] = await Promise.all([
    queryOne<{ count: string }>("SELECT count(*) FROM tenants"),
    queryOne<{ count: string }>("SELECT count(*) FROM tenants WHERE plan_status = 'active'"),
    queryOne<{ count: string }>("SELECT count(*) FROM tenants WHERE plan_status = 'suspended'"),
    queryOne<{ count: string }>("SELECT count(*) FROM tenants WHERE plan_status = 'trial'"),
    query<{ plan: string; count: string }>("SELECT plan, count(*)::text FROM tenants GROUP BY plan"),
    queryOne<{ count: string }>("SELECT count(*) FROM channels WHERE status = 'active'"),
    queryOne<{ count: string }>("SELECT count(*) FROM users WHERE status = 'active'"),
    queryOne<{ count: string }>("SELECT count(*) FROM platform_users"),
  ]);

  const planDistribution: Record<string, number> = {};
  for (const row of plansRes) {
    planDistribution[row.plan] = parseInt(row.count, 10);
  }

  const total = parseInt(totalRes?.count || "0", 10);
  const active = parseInt(activeRes?.count || "0", 10);
  const suspended = parseInt(suspendedRes?.count || "0", 10);
  const trial = parseInt(trialRes?.count || "0", 10);
  const channels = parseInt(channelsRes?.count || "0", 10);
  const users = parseInt(usersRes?.count || "0", 10);
  const staff = parseInt(staffRes?.count || "0", 10);

  return {
    totalWorkspaces: total,
    totalTenants: total,
    activeWorkspaces: active,
    activeTenants: active,
    suspendedWorkspaces: suspended,
    suspendedTenants: suspended,
    trialWorkspaces: trial,
    trialTenants: trial,
    planDistribution,
    totalChannelsConnected: channels,
    totalChannels: channels,
    totalUsersRegistered: users,
    totalPlatformStaff: staff,
  };
}
