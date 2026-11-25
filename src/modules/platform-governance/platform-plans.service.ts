import { query, queryOne, withTransaction } from "../../db/pool";
import { isSupportedCurrency } from "../billing/currency";
import { FeatureFlags, parseFeatureFlags } from "../billing/plan-limits.service";
import { httpError } from "../../utils/http-error";

/** One currency's price list for a plan (plan/017). */
export interface PlanPrice {
  currency: string;
  priceMonthly: number;
  priceYearly: number;
  isActive: boolean;
}

export interface PlanPriceInput {
  currency: string;
  priceMonthly: number;
  /** Defaults to 10 x monthly ("2 months free"). */
  priceYearly?: number;
  isActive?: boolean;
}

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
  /** Gated features the plan includes (plan/017 Phase 4); `features` above is display-only text. */
  featureFlags: FeatureFlags;
  badgeText: string | null;
  isActive: boolean;
  isPublic: boolean;
  isCustom: boolean;
  createdAt: string;
  updatedAt: string;
  /** Per-currency prices. `priceMonthly` / `priceYearly` / `currency` above are the legacy single price. */
  prices: PlanPrice[];
}

export interface CreatePlatformPlanDto {
  id: string;
  name: string;
  description?: string;
  /** Per-currency prices; when omitted a single price is derived from priceMonthly/priceYearly/currency. */
  prices?: PlanPriceInput[];
  priceMonthly: number;
  priceYearly?: number;
  currency?: string;
  maxChannels: number;
  maxContacts: number;
  maxMonthlyMessages: number;
  maxMonthlyAiQueries: number;
  features?: string[];
  featureFlags?: Partial<FeatureFlags>;
  badgeText?: string;
  isActive?: boolean;
  isPublic?: boolean;
  isCustom?: boolean;
}

export interface UpdatePlatformPlanDto {
  name?: string;
  description?: string;
  /** Replaces the plan's whole per-currency price list. */
  prices?: PlanPriceInput[];
  priceMonthly?: number;
  priceYearly?: number;
  currency?: string;
  maxChannels?: number;
  maxContacts?: number;
  maxMonthlyMessages?: number;
  maxMonthlyAiQueries?: number;
  features?: string[];
  featureFlags?: Partial<FeatureFlags>;
  badgeText?: string;
  isActive?: boolean;
  isPublic?: boolean;
  isCustom?: boolean;
}

/** Rejects anything that is not an object, so a typo cannot silently clear every flag. */
function assertFeatureFlagsInput(input: unknown): void {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw httpError(400, 'featureFlags must be an object such as { "ai_copilot": true }');
  }
}

function mapPlanRow(r: any, prices: PlanPrice[] = []): PlatformPlanItem {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    priceMonthly: parseFloat(r.price_monthly || "0"),
    priceYearly: parseFloat(r.price_yearly || "0"),
    currency: r.currency || "USD",
    maxChannels: parseInt(r.max_channels || "1", 10),
    maxContacts: parseInt(r.max_contacts || "500", 10),
    maxMonthlyMessages: parseInt(r.max_monthly_messages || "2000", 10),
    maxMonthlyAiQueries: parseInt(r.max_monthly_ai_queries || "100", 10),
    features: Array.isArray(r.features) ? r.features : typeof r.features === "string" ? JSON.parse(r.features) : [],
    featureFlags: parseFeatureFlags(r.feature_flags),
    badgeText: r.badge_text,
    isActive: Boolean(r.is_active),
    isPublic: Boolean(r.is_public),
    isCustom: Boolean(r.is_custom),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    prices,
  };
}

async function loadPlanPrices(planIds: string[]): Promise<Map<string, PlanPrice[]>> {
  const byPlan = new Map<string, PlanPrice[]>();
  if (planIds.length === 0) return byPlan;
  const rows = await query<any>(
    `SELECT plan_id, currency, price_monthly, price_yearly, is_active
     FROM platform_plan_prices
     WHERE plan_id = ANY($1::text[])
     ORDER BY currency`,
    [planIds]
  );
  for (const r of rows) {
    const list = byPlan.get(r.plan_id) ?? [];
    list.push({
      currency: String(r.currency).trim(),
      priceMonthly: parseFloat(r.price_monthly || "0"),
      priceYearly: parseFloat(r.price_yearly || "0"),
      isActive: Boolean(r.is_active),
    });
    byPlan.set(r.plan_id, list);
  }
  return byPlan;
}

/** Validates admin input; throws a readable error for anything we cannot bill in. */
function normalizePlanPrices(inputs: PlanPriceInput[]): Array<Required<PlanPriceInput>> {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("A plan needs at least one price (currency).");
  }
  const seen = new Set<string>();
  return inputs.map((input) => {
    const currency = String(input?.currency ?? "").trim().toUpperCase();
    if (!isSupportedCurrency(currency)) {
      throw new Error(`Unsupported currency '${currency || "?"}'. Supported: INR, USD.`);
    }
    if (seen.has(currency)) throw new Error(`Currency ${currency} is listed twice.`);
    seen.add(currency);

    const priceMonthly = Number(input.priceMonthly);
    if (!Number.isFinite(priceMonthly) || priceMonthly < 0) {
      throw new Error(`Monthly price for ${currency} must be a number of 0 or more.`);
    }
    const priceYearly = input.priceYearly === undefined ? priceMonthly * 10 : Number(input.priceYearly);
    if (!Number.isFinite(priceYearly) || priceYearly < 0) {
      throw new Error(`Yearly price for ${currency} must be a number of 0 or more.`);
    }
    return { currency, priceMonthly, priceYearly, isActive: input.isActive !== false };
  });
}

/**
 * Replaces a plan's price list. Prices of currencies not listed are removed. The USD price (or the
 * first one listed) is mirrored into the legacy platform_plans columns so older readers keep working.
 */
async function savePlanPrices(planId: string, inputs: PlanPriceInput[]): Promise<void> {
  const prices = normalizePlanPrices(inputs);
  const legacy = prices.find((p) => p.currency === "USD") ?? prices[0];

  await withTransaction(async (client) => {
    for (const p of prices) {
      await client.query(
        `INSERT INTO platform_plan_prices (plan_id, currency, price_monthly, price_yearly, is_active)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (plan_id, currency)
         DO UPDATE SET price_monthly = EXCLUDED.price_monthly, price_yearly = EXCLUDED.price_yearly,
                       is_active = EXCLUDED.is_active, updated_at = now()`,
        [planId, p.currency, p.priceMonthly, p.priceYearly, p.isActive]
      );
    }
    await client.query(
      "DELETE FROM platform_plan_prices WHERE plan_id = $1 AND NOT (currency = ANY($2::text[]))",
      [planId, prices.map((p) => p.currency)]
    );
    await client.query(
      `UPDATE platform_plans
       SET price_monthly = $2, price_yearly = $3, currency = $4, updated_at = now()
       WHERE id = $1`,
      [planId, legacy.priceMonthly, legacy.priceYearly, legacy.currency]
    );
  });
}

export async function listPlatformPlans(options: { includeInactive?: boolean; publicOnly?: boolean } = {}): Promise<PlatformPlanItem[]> {
  const conditions: string[] = [];
  const params: any[] = [];

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
           features, to_jsonb(platform_plans) -> 'feature_flags' AS feature_flags,
           badge_text, is_active, is_public, is_custom, created_at, updated_at
    FROM platform_plans
    ${whereClause}
    ORDER BY price_monthly ASC, created_at ASC
  `;

  const rows = await query<any>(sql, params);
  const prices = await loadPlanPrices(rows.map((r) => r.id));
  return rows.map((r) => mapPlanRow(r, prices.get(r.id)));
}

export async function getPlatformPlanById(id: string): Promise<PlatformPlanItem | null> {
  const row = await queryOne<any>(
    `SELECT id, name, description, price_monthly, price_yearly, currency,
            max_channels, max_contacts, max_monthly_messages, max_monthly_ai_queries,
            features, to_jsonb(platform_plans) -> 'feature_flags' AS feature_flags,
            badge_text, is_active, is_public, is_custom, created_at, updated_at
     FROM platform_plans
     WHERE lower(id) = lower($1)`,
    [id]
  );

  if (!row) return null;
  const prices = await loadPlanPrices([row.id]);
  return mapPlanRow(row, prices.get(row.id));
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

  // Validate before inserting so a bad price list never leaves a half-created plan behind.
  const priceInputs: PlanPriceInput[] =
    dto.prices && dto.prices.length > 0
      ? dto.prices
      : [
          {
            currency: (dto.currency || "USD").toUpperCase(),
            priceMonthly: Math.max(0, dto.priceMonthly || 0),
            priceYearly: dto.priceYearly,
          },
        ];
  const normalizedPrices = normalizePlanPrices(priceInputs);
  const legacy = normalizedPrices.find((p) => p.currency === "USD") ?? normalizedPrices[0];
  const priceMonthly = legacy.priceMonthly;
  const priceYearly = legacy.priceYearly;
  const currency = legacy.currency;

  const maxChannels = Math.max(1, dto.maxChannels || 1);
  const maxContacts = Math.max(10, dto.maxContacts || 500);
  const maxMonthlyMessages = Math.max(100, dto.maxMonthlyMessages || 2000);
  const maxMonthlyAiQueries = Math.max(0, dto.maxMonthlyAiQueries || 100);
  const featuresJson = JSON.stringify(dto.features || []);
  if (dto.featureFlags !== undefined) assertFeatureFlagsInput(dto.featureFlags);

  await queryOne<any>(
    `INSERT INTO platform_plans (
       id, name, description, price_monthly, price_yearly, currency,
       max_channels, max_contacts, max_monthly_messages, max_monthly_ai_queries,
       features, badge_text, is_active, is_public, is_custom
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15)
     RETURNING id`,
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

  await savePlanPrices(planId, normalizedPrices);
  if (dto.featureFlags !== undefined) {
    await query("UPDATE platform_plans SET feature_flags = $1::jsonb WHERE id = $2", [
      JSON.stringify(parseFeatureFlags(dto.featureFlags)),
      planId,
    ]);
  }
  return (await getPlatformPlanById(planId)) as PlatformPlanItem;
}

export async function updatePlatformPlan(id: string, dto: UpdatePlatformPlanDto): Promise<PlatformPlanItem> {
  const existing = await getPlatformPlanById(id);
  if (!existing) {
    throw new Error(`Plan '${id}' not found.`);
  }

  // Reject a bad price list before touching anything else.
  if (dto.prices !== undefined) normalizePlanPrices(dto.prices);
  if (dto.featureFlags !== undefined) assertFeatureFlagsInput(dto.featureFlags);

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
  if (dto.featureFlags !== undefined) {
    updates.push(`feature_flags = $${idx++}::jsonb`);
    values.push(JSON.stringify(parseFeatureFlags(dto.featureFlags)));
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

  values.push(existing.id.toLowerCase());
  await query(`UPDATE platform_plans SET ${updates.join(", ")} WHERE lower(id) = $${idx}`, values);

  if (dto.prices !== undefined) {
    await savePlanPrices(existing.id, dto.prices);
  } else if (dto.priceMonthly !== undefined || dto.priceYearly !== undefined || dto.currency !== undefined) {
    // Legacy single-price edit: keep that currency's price row in step with it.
    const current = (await getPlatformPlanById(existing.id)) as PlatformPlanItem;
    const others = current.prices.filter((p) => p.currency.toUpperCase() !== current.currency.toUpperCase());
    await savePlanPrices(existing.id, [
      ...others,
      { currency: current.currency, priceMonthly: current.priceMonthly, priceYearly: current.priceYearly },
    ]);
  }

  return (await getPlatformPlanById(existing.id)) as PlatformPlanItem;
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

  await query("DELETE FROM platform_plans WHERE lower(id) = lower($1)", [id]);
  return {
    deleted: true,
    deactivated: false,
    message: `Plan '${id}' successfully removed.`,
  };
}
