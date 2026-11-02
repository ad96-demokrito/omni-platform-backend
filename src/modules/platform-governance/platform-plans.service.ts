import { query, queryOne } from "../../db/pool";

export interface PlatformPlanItem {
  id: string;
  name: string;
  description: string | null;
  priceMonthly: number;
  priceYearly: number;
  currency: string;
  maxChannels: number;
  maxContacts: number;
  maxMonthlyMessages: number;
  maxMonthlyAiQueries: number;
  features: string[];
  badgeText: string | null;
  isActive: boolean;
  isPublic: boolean;
  isCustom: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePlatformPlanDto {
  id: string;
  name: string;
  description?: string;
  priceMonthly: number;
  priceYearly?: number;
  currency?: string;
  maxChannels: number;
  maxContacts: number;
  maxMonthlyMessages: number;
  maxMonthlyAiQueries: number;
  features?: string[];
  badgeText?: string;
  isActive?: boolean;
  isPublic?: boolean;
  isCustom?: boolean;
}

export interface UpdatePlatformPlanDto {
  name?: string;
  description?: string;
  priceMonthly?: number;
  priceYearly?: number;
  currency?: string;
  maxChannels?: number;
  maxContacts?: number;
  maxMonthlyMessages?: number;
  maxMonthlyAiQueries?: number;
  features?: string[];
  badgeText?: string;
  isActive?: boolean;
  isPublic?: boolean;
  isCustom?: boolean;
}

function mapPlanRow(r: any): PlatformPlanItem {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    priceMonthly: parseFloat(r.price_monthly || "0"),
    priceYearly: parseFloat(r.price_yearly || "0"),
    currency: r.currency || "INR",
    maxChannels: parseInt(r.max_channels || "1", 10),
    maxContacts: parseInt(r.max_contacts || "500", 10),
    maxMonthlyMessages: parseInt(r.max_monthly_messages || "2000", 10),
    maxMonthlyAiQueries: parseInt(r.max_monthly_ai_queries || "100", 10),
    features: Array.isArray(r.features) ? r.features : typeof r.features === "string" ? JSON.parse(r.features) : [],
    badgeText: r.badge_text,
    isActive: Boolean(r.is_active),
    isPublic: Boolean(r.is_public),
    isCustom: Boolean(r.is_custom),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listPlatformPlans(options: { includeInactive?: boolean; publicOnly?: boolean } = {}): Promise<PlatformPlanItem[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (!options.includeInactive) {
    conditions.push(`is_active = true`);
  }

  if (options.publicOnly) {
    conditions.push(`is_public = true`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT id, name, description, price_monthly, price_yearly, currency,
           max_channels, max_contacts, max_monthly_messages, max_monthly_ai_queries,
           features, badge_text, is_active, is_public, is_custom, created_at, updated_at
    FROM platform_plans
    ${whereClause}
    ORDER BY price_monthly ASC, created_at ASC
  `;

  const rows = await query<any>(sql, params);
  return rows.map(mapPlanRow);
}

export async function getPlatformPlanById(id: string): Promise<PlatformPlanItem | null> {
  const row = await queryOne<any>(
    `SELECT id, name, description, price_monthly, price_yearly, currency,
            max_channels, max_contacts, max_monthly_messages, max_monthly_ai_queries,
            features, badge_text, is_active, is_public, is_custom, created_at, updated_at
     FROM platform_plans
     WHERE lower(id) = lower($1)`,
    [id]
  );

  return row ? mapPlanRow(row) : null;
}

export async function createPlatformPlan(dto: CreatePlatformPlanDto): Promise<PlatformPlanItem> {
  const planId = dto.id.toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
  if (!planId) {
    throw new Error("Invalid plan identifier. Use alphanumeric characters, dashes, or underscores.");
  }

  const existing = await getPlatformPlanById(planId);
  if (existing) {
    throw new Error(`A plan with ID '${planId}' already exists.`);
  }

  const priceMonthly = Math.max(0, dto.priceMonthly || 0);
  const priceYearly = dto.priceYearly !== undefined ? Math.max(0, dto.priceYearly) : priceMonthly * 10;
  const currency = (dto.currency || "INR").toUpperCase();
  const maxChannels = Math.max(1, dto.maxChannels || 1);
  const maxContacts = Math.max(10, dto.maxContacts || 500);
  const maxMonthlyMessages = Math.max(100, dto.maxMonthlyMessages || 2000);
  const maxMonthlyAiQueries = Math.max(0, dto.maxMonthlyAiQueries || 100);
  const featuresJson = JSON.stringify(dto.features || []);

  const row = await queryOne<any>(
    `INSERT INTO platform_plans (
       id, name, description, price_monthly, price_yearly, currency,
       max_channels, max_contacts, max_monthly_messages, max_monthly_ai_queries,
       features, badge_text, is_active, is_public, is_custom
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15)
     RETURNING id, name, description, price_monthly, price_yearly, currency,
               max_channels, max_contacts, max_monthly_messages, max_monthly_ai_queries,
               features, badge_text, is_active, is_public, is_custom, created_at, updated_at`,
    [
      planId,
      dto.name.trim(),
      dto.description || null,
      priceMonthly,
      priceYearly,
      currency,
      maxChannels,
      maxContacts,
      maxMonthlyMessages,
      maxMonthlyAiQueries,
      featuresJson,
      dto.badgeText || null,
      dto.isActive !== undefined ? dto.isActive : true,
      dto.isPublic !== undefined ? dto.isPublic : true,
      dto.isCustom !== undefined ? dto.isCustom : false,
    ]
  );

  return mapPlanRow(row);
}

export async function updatePlatformPlan(id: string, dto: UpdatePlatformPlanDto): Promise<PlatformPlanItem> {
  const existing = await getPlatformPlanById(id);
  if (!existing) {
    throw new Error(`Plan '${id}' not found.`);
  }

  const updates: string[] = ["updated_at = now()"];
  const values: any[] = [];
  let idx = 1;

  if (dto.name !== undefined) {
    updates.push(`name = $${idx++}`);
    values.push(dto.name.trim());
  }
  if (dto.description !== undefined) {
    updates.push(`description = $${idx++}`);
    values.push(dto.description);
  }
  if (dto.priceMonthly !== undefined) {
    updates.push(`price_monthly = $${idx++}`);
    values.push(Math.max(0, dto.priceMonthly));
  }
  if (dto.priceYearly !== undefined) {
    updates.push(`price_yearly = $${idx++}`);
    values.push(Math.max(0, dto.priceYearly));
  }
  if (dto.currency !== undefined) {
    updates.push(`currency = $${idx++}`);
    values.push(dto.currency.toUpperCase());
  }
  if (dto.maxChannels !== undefined) {
    updates.push(`max_channels = $${idx++}`);
    values.push(Math.max(1, dto.maxChannels));
  }
  if (dto.maxContacts !== undefined) {
    updates.push(`max_contacts = $${idx++}`);
    values.push(Math.max(10, dto.maxContacts));
  }
  if (dto.maxMonthlyMessages !== undefined) {
    updates.push(`max_monthly_messages = $${idx++}`);
    values.push(Math.max(100, dto.maxMonthlyMessages));
  }
  if (dto.maxMonthlyAiQueries !== undefined) {
    updates.push(`max_monthly_ai_queries = $${idx++}`);
    values.push(Math.max(0, dto.maxMonthlyAiQueries));
  }
  if (dto.features !== undefined) {
    updates.push(`features = $${idx++}::jsonb`);
    values.push(JSON.stringify(dto.features));
  }
  if (dto.badgeText !== undefined) {
    updates.push(`badge_text = $${idx++}`);
    values.push(dto.badgeText || null);
  }
  if (dto.isActive !== undefined) {
    updates.push(`is_active = $${idx++}`);
    values.push(dto.isActive);
  }
  if (dto.isPublic !== undefined) {
    updates.push(`is_public = $${idx++}`);
    values.push(dto.isPublic);
  }
  if (dto.isCustom !== undefined) {
    updates.push(`is_custom = $${idx++}`);
    values.push(dto.isCustom);
  }

  values.push(id.toLowerCase());
  const sql = `
    UPDATE platform_plans
    SET ${updates.join(", ")}
    WHERE lower(id) = $${idx}
    RETURNING id, name, description, price_monthly, price_yearly, currency,
              max_channels, max_contacts, max_monthly_messages, max_monthly_ai_queries,
              features, badge_text, is_active, is_public, is_custom, created_at, updated_at
  `;

  const row = await queryOne<any>(sql, values);
  return mapPlanRow(row);
}

export async function deleteOrDeactivatePlatformPlan(id: string): Promise<{ deleted: boolean; deactivated: boolean; message: string }> {
  // Check if active tenants are currently on this plan
  const countRes = await queryOne<{ count: string }>(
    "SELECT count(*) as count FROM tenants WHERE lower(plan) = lower($1) OR lower(plan_status) = lower($1)",
    [id]
  );
  const attachedTenantsCount = parseInt(countRes?.count || "0", 10);

  if (attachedTenantsCount > 0) {
    // Cannot hard-delete if tenants use it; deactivate it instead
    await query("UPDATE platform_plans SET is_active = false, is_public = false, updated_at = now() WHERE lower(id) = lower($1)", [id]);
    return {
      deleted: false,
      deactivated: true,
      message: `Plan '${id}' is currently assigned to ${attachedTenantsCount} workspace(s). It has been deactivated and hidden from public selection instead of deleted.`,
    };
  }

  const result = await query("DELETE FROM platform_plans WHERE lower(id) = lower($1)", [id]);
  return {
    deleted: true,
    deactivated: false,
    message: `Plan '${id}' successfully removed.`,
  };
}
