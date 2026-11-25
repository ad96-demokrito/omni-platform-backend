import type { NextFunction, Response } from "express";
import { queryOne } from "../../db/pool";
import { ensureRedisConnected, redis } from "../../db/redis";
import { getMongoDb } from "../../db/mongo";
import { httpError } from "../../utils/http-error";
import { logger } from "../../utils/logger";
import type { AuthedRequest } from "../../middleware/auth";

/**
 * Plan limits and feature flags (plan/017, Phase 4).
 *
 * Two things a plan decides: how much a workspace may use (channels, contacts, messages and AI requests per
 * month) and which gated features it includes. Both are enforced here, in one place, behind PLAN_ENFORCEMENT:
 *
 *   off      nothing is checked.
 *   warn     (default) nothing is blocked; every request that WOULD have been blocked is logged and counted, so the
 *            owner can see the effect on existing workspaces before switching on.
 *   enforce  the request is refused with HTTP 402 and a machine-readable `code`.
 *
 * Inbound traffic is never blocked: customers' messages and auto-created contacts are recorded, only counted.
 * Everything here fails OPEN: if Redis, Mongo or the database cannot answer, the request goes through and the
 * problem is logged, because a billing check must never be the reason messages stop flowing.
 */

const log = logger.child({ module: "plan-limits" });

export type EnforcementMode = "off" | "warn" | "enforce";
export type LimitMetric = "channels" | "contacts" | "messages" | "aiQueries";

export const PLAN_FEATURES = ["ai_copilot", "api_keys", "audit_compliance", "teams_roles"] as const;
export type PlanFeature = (typeof PLAN_FEATURES)[number];
export type FeatureFlags = Record<PlanFeature, boolean>;

/** A limit of -1 means "no limit". */
export const UNLIMITED = -1;

const ENTITLEMENTS_CACHE_MS = 15_000;
const ENTITLEMENTS_CACHE_MAX = 5_000;
/** Counters are re-read from the source of truth this often, which also heals any drift. */
const COUNTER_TTL_SECONDS = 600;
const WOULD_BLOCK_RETENTION_SECONDS = 40 * 24 * 60 * 60;
const WARN_LOG_INTERVAL_MS = 60 * 60 * 1000;

const LOCKED_FEATURE_MESSAGES: Record<PlanFeature, string> = {
  ai_copilot: "AI Copilot and knowledge bases are not included in your plan. Upgrade your plan to use them.",
  api_keys: "Developer API keys are not included in your plan. Upgrade your plan to use them.",
  audit_compliance: "The audit trail and data-privacy tools are not included in your plan. Upgrade your plan to use them.",
  teams_roles: "Support teams and custom member roles are not included in your plan. Upgrade your plan to use them.",
};

export function enforcementMode(): EnforcementMode {
  const raw = (process.env.PLAN_ENFORCEMENT || "warn").trim().toLowerCase();
  return raw === "off" || raw === "enforce" ? raw : "warn";
}

// ---------------------------------------------------------------------------------------------------------------
// Entitlements: what the workspace's plan (and any per-workspace override) allows
// ---------------------------------------------------------------------------------------------------------------

export interface Entitlements {
  planId: string | null;
  planStatus: string;
  /** Per-metric limit; `UNLIMITED` (-1) when there is none. */
  limits: Record<LimitMetric, number>;
  features: FeatureFlags;
}

interface EntitlementsRow {
  plan: string | null;
  plan_status: string | null;
  max_channels: number | null;
  max_contacts: number | null;
  max_monthly_messages: number | null;
  max_monthly_ai_queries: number | null;
  plan_max_channels: number | null;
  plan_max_contacts: number | null;
  plan_max_monthly_messages: number | null;
  plan_max_monthly_ai_queries: number | null;
  feature_flags?: Record<string, unknown> | string | null;
}

export const ALL_FEATURES_ON: FeatureFlags = {
  ai_copilot: true,
  api_keys: true,
  audit_compliance: true,
  teams_roles: true,
};

const entitlementsCache = new Map<string, { at: number; value: Entitlements }>();

// Flips to false if migration 022 (platform_plans.feature_flags) has not been applied yet, so the app keeps
// working on an old schema (every feature on) instead of failing every request.
let hasFeatureFlagsColumn = true;

const ENTITLEMENTS_SELECT = (withFlags: boolean): string => `
  SELECT t.plan, t.plan_status, t.max_channels, t.max_contacts, t.max_monthly_messages, t.max_monthly_ai_queries,
         pp.max_channels AS plan_max_channels, pp.max_contacts AS plan_max_contacts,
         pp.max_monthly_messages AS plan_max_monthly_messages,
         pp.max_monthly_ai_queries AS plan_max_monthly_ai_queries
         ${withFlags ? ", pp.feature_flags" : ""}
  FROM tenants t
  LEFT JOIN platform_plans pp ON lower(pp.id) = lower(t.plan)
  WHERE t.id = $1`;

/** The workspace's own value wins when it is set (> 0 or -1); otherwise the plan's; otherwise no limit. */
function resolveLimit(tenantValue: number | null, planValue: number | null): number {
  if (tenantValue === UNLIMITED || (tenantValue !== null && tenantValue > 0)) return tenantValue;
  if (planValue === UNLIMITED || (planValue !== null && planValue >= 0)) return planValue;
  return UNLIMITED;
}

export function parseFeatureFlags(raw: unknown): FeatureFlags {
  let source: unknown = raw;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      source = {};
    }
  }
  const record = source && typeof source === "object" ? (source as Record<string, unknown>) : {};
  return {
    ai_copilot: record.ai_copilot === true,
    api_keys: record.api_keys === true,
    audit_compliance: record.audit_compliance === true,
    teams_roles: record.teams_roles === true,
  };
}

async function loadEntitlements(tenantId: string): Promise<Entitlements | null> {
  let row: EntitlementsRow | null = null;
  if (hasFeatureFlagsColumn) {
    try {
      row = await queryOne<EntitlementsRow>(ENTITLEMENTS_SELECT(true), [tenantId]);
    } catch (err: unknown) {
      if ((err as { code?: string })?.code !== "42703") throw err; // 42703 = undefined_column
      hasFeatureFlagsColumn = false;
    }
  }
  if (!hasFeatureFlagsColumn) {
    row = await queryOne<EntitlementsRow>(ENTITLEMENTS_SELECT(false), [tenantId]);
  }
  if (!row) return null;

  return {
    planId: row.plan,
    planStatus: row.plan_status || "active",
    limits: {
      channels: resolveLimit(row.max_channels, row.plan_max_channels),
      contacts: resolveLimit(row.max_contacts, row.plan_max_contacts),
      messages: resolveLimit(row.max_monthly_messages, row.plan_max_monthly_messages),
      aiQueries: resolveLimit(row.max_monthly_ai_queries, row.plan_max_monthly_ai_queries),
    },
    // A plan row that does not exist (or an old schema) must not silently lock features: everything stays on.
    features: hasFeatureFlagsColumn && row.feature_flags !== undefined && row.feature_flags !== null
      ? parseFeatureFlags(row.feature_flags)
      : { ...ALL_FEATURES_ON },
  };
}

/** Cached for a few seconds: this sits on hot paths (every authenticated request, every message). */
export async function getEntitlements(tenantId: string): Promise<Entitlements | null> {
  const cached = entitlementsCache.get(tenantId);
  if (cached && Date.now() - cached.at < ENTITLEMENTS_CACHE_MS) return cached.value;

  const value = await loadEntitlements(tenantId);
  if (!value) return null;
  if (entitlementsCache.size >= ENTITLEMENTS_CACHE_MAX) entitlementsCache.clear();
  entitlementsCache.set(tenantId, { at: Date.now(), value });
  return value;
}

/** Call after a plan or limit changed so this process sees it at once (other processes catch up within seconds). */
export function invalidateEntitlements(tenantId: string): void {
  entitlementsCache.delete(tenantId);
}

// ---------------------------------------------------------------------------------------------------------------
// Usage counters
// ---------------------------------------------------------------------------------------------------------------

const monthKey = (date: Date = new Date()): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

const startOfMonth = (): Date => {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return start;
};

/** Messages stored this calendar month, inbound and outbound (the same number the usage page shows). */
export async function countMonthlyMessages(tenantId: string): Promise<number> {
  const mongo = await getMongoDb();
  const from = startOfMonth();
  return mongo.collection("messages").countDocuments({
    $and: [
      { $or: [{ tenantId }, { tenant_id: tenantId }] },
      { $or: [{ sentAt: { $gte: from } }, { createdAt: { $gte: from.toISOString() } }] },
    ],
  });
}

export async function countMonthlyAiQueries(tenantId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    "SELECT count(*) AS count FROM ai_logs WHERE tenant_id = $1 AND created_at >= date_trunc('month', now())",
    [tenantId]
  );
  return parseInt(row?.count || "0", 10);
}

async function countContacts(tenantId: string): Promise<number> {
  const row = await queryOne<{ count: string }>("SELECT count(*) AS count FROM contacts WHERE tenant_id = $1", [
    tenantId,
  ]);
  return parseInt(row?.count || "0", 10);
}

async function countActiveChannels(tenantId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    "SELECT count(*) AS count FROM channels WHERE tenant_id = $1 AND status = 'active'",
    [tenantId]
  );
  return parseInt(row?.count || "0", 10);
}

type CounterMetric = Exclude<LimitMetric, "channels">;

const counterKey = (tenantId: string, metric: CounterMetric): string =>
  metric === "contacts"
    ? `plan:usage:${tenantId}:contacts`
    : `plan:usage:${tenantId}:${metric}:${monthKey()}`;

async function countFromSource(tenantId: string, metric: CounterMetric): Promise<number> {
  if (metric === "contacts") return countContacts(tenantId);
  if (metric === "messages") return countMonthlyMessages(tenantId);
  return countMonthlyAiQueries(tenantId);
}

/** Current usage. Counters live in Redis (seeded from the source of truth) so a send never runs a COUNT. */
export async function getCurrentUsage(tenantId: string, metric: LimitMetric): Promise<number> {
  if (metric === "channels") return countActiveChannels(tenantId);

  await ensureRedisConnected();
  const key = counterKey(tenantId, metric);
  const existing = await redis.get(key);
  if (existing !== null) return parseInt(existing, 10) || 0;

  const seeded = await countFromSource(tenantId, metric);
  await redis.set(key, String(seeded), { NX: true, EX: COUNTER_TTL_SECONDS });
  return parseInt((await redis.get(key)) ?? String(seeded), 10) || 0;
}

/**
 * Adds to a usage counter after something was created/sent/answered. If the counter is not loaded it is left
 * alone: the next read seeds it from the source, which already includes this item.
 */
export async function recordUsage(tenantId: string, metric: LimitMetric, amount = 1): Promise<void> {
  if (metric === "channels" || enforcementMode() === "off") return;
  try {
    await ensureRedisConnected();
    const key = counterKey(tenantId, metric);
    if (await redis.exists(key)) await redis.incrBy(key, amount);
  } catch (err: unknown) {
    log.warn("Could not record usage (ignored)", { tenantId, metric, error: (err as Error)?.message });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------------------------

const lastWarnAt = new Map<string, number>();

/** Logs a would-be block at most once an hour per workspace and reason, so warn mode cannot flood the log. */
function warnOnce(key: string, message: string, meta: Record<string, unknown>): void {
  const now = Date.now();
  const previous = lastWarnAt.get(key);
  if (previous !== undefined && now - previous < WARN_LOG_INTERVAL_MS) return;
  if (lastWarnAt.size > 10_000) lastWarnAt.clear();
  lastWarnAt.set(key, now);
  log.warn(message, meta);
}

/** Counts every would-be block per workspace and reason for the month, so the owner can review the impact. */
async function countWouldBlock(tenantId: string, reason: string): Promise<void> {
  try {
    await ensureRedisConnected();
    const key = `plan:wouldblock:${tenantId}:${reason}:${monthKey()}`;
    await redis.incr(key);
    await redis.expire(key, WOULD_BLOCK_RETENTION_SECONDS);
  } catch {
    // Reporting only: never worth failing a request for.
  }
}

const formatCount = (value: number): string => value.toLocaleString("en-US");

function limitMessage(metric: LimitMetric, limit: number): string {
  switch (metric) {
    case "channels":
      return `Your plan allows ${formatCount(limit)} active channel${limit === 1 ? "" : "s"}. Upgrade your plan to connect more.`;
    case "contacts":
      return `Your plan allows ${formatCount(limit)} contacts. Upgrade your plan to add more.`;
    case "messages":
      return `You have reached this month's limit of ${formatCount(limit)} messages. Upgrade your plan to keep sending.`;
    case "aiQueries":
      return `You have used all ${formatCount(limit)} AI requests included this month. Upgrade your plan to use more.`;
  }
}

/** The error to throw (enforce) for a metric that is over its limit, or null when the workspace is within it. */
async function limitBlock(tenantId: string, metric: LimitMetric, increment: number): Promise<Error | null> {
  const entitlements = await getEntitlements(tenantId);
  if (!entitlements) return null;
  const limit = entitlements.limits[metric];
  if (limit === UNLIMITED) return null;

  const used = await getCurrentUsage(tenantId, metric);
  if (used + increment <= limit) return null;

  return httpError(402, limitMessage(metric, limit), {
    code: "PLAN_LIMIT_REACHED",
    details: { metric, limit, used, planId: entitlements.planId },
  });
}

/**
 * Throws a 402 `PLAN_LIMIT_REACHED` when adding `increment` would exceed the workspace's limit (enforce mode).
 * In warn mode it only logs/counts and returns. Never throws for anything except the limit itself.
 */
export async function assertWithinLimit(
  tenantId: string,
  metric: LimitMetric,
  options: { increment?: number } = {}
): Promise<void> {
  const mode = enforcementMode();
  if (mode === "off") return;

  let block: Error | null;
  try {
    block = await limitBlock(tenantId, metric, options.increment ?? 1);
  } catch (err: unknown) {
    log.warn("Plan limit check failed, letting the request through", {
      tenantId,
      metric,
      error: (err as Error)?.message,
    });
    return;
  }
  if (!block) return;

  if (mode === "enforce") throw block;

  const details = (block as { details?: Record<string, unknown> }).details ?? {};
  warnOnce(`limit:${tenantId}:${metric}`, "plan.limit.would_block (PLAN_ENFORCEMENT=warn, nothing was blocked)", {
    tenantId,
    metric,
    limit: details.limit,
    used: details.used,
  });
  await countWouldBlock(tenantId, `limit_${metric}`);
}

/** The error for a gated feature the plan lacks, or null. Fails open when the plan cannot be read. */
export async function featureBlock(tenantId: string, feature: PlanFeature): Promise<Error | null> {
  const entitlements = await getEntitlements(tenantId);
  if (!entitlements || entitlements.features[feature]) return null;
  return httpError(402, LOCKED_FEATURE_MESSAGES[feature], {
    code: "FEATURE_NOT_IN_PLAN",
    details: { feature, planId: entitlements.planId },
  });
}

/** Throws 402 `FEATURE_NOT_IN_PLAN` (enforce) when the workspace's plan does not include `feature`. */
export async function assertFeature(tenantId: string, feature: PlanFeature): Promise<void> {
  const mode = enforcementMode();
  if (mode === "off") return;

  let block: Error | null;
  try {
    block = await featureBlock(tenantId, feature);
  } catch (err: unknown) {
    log.warn("Plan feature check failed, letting the request through", {
      tenantId,
      feature,
      error: (err as Error)?.message,
    });
    return;
  }
  if (!block) return;

  if (mode === "enforce") throw block;

  warnOnce(`feature:${tenantId}:${feature}`, "plan.feature.would_block (PLAN_ENFORCEMENT=warn, nothing was blocked)", {
    tenantId,
    feature,
  });
  await countWouldBlock(tenantId, `feature_${feature}`);
}

/**
 * Start of every AI call (copilot, knowledge-base answer, intent routing), whoever triggered it: the plan must
 * include the AI feature and have requests left this month. The request is counted at once.
 */
export async function assertAiAllowed(tenantId: string): Promise<void> {
  await assertFeature(tenantId, "ai_copilot");
  await assertWithinLimit(tenantId, "aiQueries");
  await recordUsage(tenantId, "aiQueries");
}

/** Express middleware: place it after `requireAuth`. */
export function requireFeature(feature: PlanFeature) {
  return async (req: AuthedRequest, _res: Response, next: NextFunction): Promise<void> => {
    try {
      await assertFeature(req.auth!.tenantId, feature);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Paths that stay usable when a workspace is suspended, so the owner can still sign in, pay and ask for help. */
const SUSPENDED_ALLOWED_PREFIXES = ["/api/auth", "/api/billing", "/api/support"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * For `requireAuth`: a suspended workspace can read but not change anything (apart from billing, sign-in and
 * support). Returns the error to send (enforce), or null. Never throws.
 */
export async function suspendedWorkspaceBlock(
  tenantId: string,
  method: string,
  baseUrl: string
): Promise<Error | null> {
  const mode = enforcementMode();
  if (mode === "off" || SAFE_METHODS.has(method.toUpperCase())) return null;
  if (SUSPENDED_ALLOWED_PREFIXES.some((prefix) => baseUrl.startsWith(prefix))) return null;

  try {
    const entitlements = await getEntitlements(tenantId);
    if (!entitlements || entitlements.planStatus !== "suspended") return null;
    if (mode === "warn") {
      warnOnce(`suspended:${tenantId}`, "plan.workspace.would_block (suspended workspace, PLAN_ENFORCEMENT=warn)", {
        tenantId,
      });
      return null;
    }
    return httpError(403, "This workspace is suspended. Please contact support.", { code: "WORKSPACE_SUSPENDED" });
  } catch (err: unknown) {
    log.warn("Workspace status check failed, letting the request through", {
      tenantId,
      error: (err as Error)?.message,
    });
    return null;
  }
}

/** For `requireAuth` on the developer-API-key path: the key stops working when the plan has no API access. */
export async function apiKeyFeatureBlock(tenantId: string): Promise<Error | null> {
  const mode = enforcementMode();
  if (mode === "off") return null;
  try {
    const block = await featureBlock(tenantId, "api_keys");
    if (!block) return null;
    if (mode === "warn") {
      warnOnce(`feature:${tenantId}:api_keys`, "plan.feature.would_block (API key request, PLAN_ENFORCEMENT=warn)", {
        tenantId,
        feature: "api_keys",
      });
      await countWouldBlock(tenantId, "feature_api_keys");
      return null;
    }
    return block;
  } catch (err: unknown) {
    log.warn("API key plan check failed, letting the request through", {
      tenantId,
      error: (err as Error)?.message,
    });
    return null;
  }
}

/** Review data for warn mode: how many requests would have been blocked this month, per workspace and reason. */
export async function listWouldBlockCounts(): Promise<Array<{ tenantId: string; reason: string; count: number }>> {
  await ensureRedisConnected();
  const results: Array<{ tenantId: string; reason: string; count: number }> = [];
  const suffix = `:${monthKey()}`;
  for await (const key of redis.scanIterator({ MATCH: "plan:wouldblock:*", COUNT: 200 })) {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) {
      if (!k.endsWith(suffix)) continue;
      const [, , tenantId, reason] = k.split(":");
      const count = parseInt((await redis.get(k)) ?? "0", 10) || 0;
      results.push({ tenantId, reason, count });
    }
  }
  return results.sort((a, b) => b.count - a.count);
}

/** Used by the Plans admin page: an unknown key is dropped, a non-true value is "not included". */
export function sanitizeFeatureFlags(input: unknown): FeatureFlags {
  return parseFeatureFlags(input);
}
