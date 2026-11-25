import { query, queryOne } from "../../db/pool";
import { AuditService } from "../audit/audit.service";
import { emailService } from "../email/email.service";
import { updateTenantSubscriptionLifecycle } from "../platform-governance/platform-subscriptions.service";
import { logger } from "../../utils/logger";

/**
 * Keeps workspaces honest about the period they paid for (plan/017, Phase 3):
 *  - a plan whose paid period AND grace window ran out is moved to the Free plan;
 *  - a prepaid plan (no automatic renewal) that ends soon gets one reminder email.
 *
 * It is controlled by PLAN_LIFECYCLE_MODE:
 *   off     the job does not run
 *   warn    (default) it only logs what it WOULD do. Safe to deploy: no workspace is changed and no email is sent
 *   enforce it downgrades and sends the emails
 * Start in `warn`, read the log for a few days (it lists how many workspaces would be affected), then switch.
 */

const log = logger.child({ module: "plan-lifecycle" });

export type PlanLifecycleMode = "off" | "warn" | "enforce";

export function planLifecycleMode(): PlanLifecycleMode {
  const raw = (process.env.PLAN_LIFECYCLE_MODE || "warn").trim().toLowerCase();
  return raw === "off" || raw === "enforce" ? raw : "warn";
}

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
};

/** Days a plan keeps working after its paid period ended (time for a retried renewal to succeed). */
export const graceDays = (): number => positiveInt(process.env.PLAN_GRACE_DAYS, 3);
/** How many days before a prepaid plan ends the reminder is sent. */
export const reminderDays = (): number => positiveInt(process.env.PLAN_EXPIRY_REMINDER_DAYS, 3);

/** Upper bound per run, so a first run on a large account cannot take the API down. */
const MAX_PER_RUN = 200;

export interface PlanLifecycleResult {
  mode: PlanLifecycleMode;
  downgraded: number;
  wouldDowngrade: number;
  remindersSent: number;
  wouldRemind: number;
}

interface TenantRow {
  id: string;
  name: string;
  plan: string;
  plan_expires_at: string;
}

async function ownerEmail(tenantId: string): Promise<string | null> {
  const row = await queryOne<{ email: string }>(
    "SELECT email FROM users WHERE tenant_id = $1 AND role = 'owner' ORDER BY created_at LIMIT 1",
    [tenantId]
  );
  return row?.email ?? null;
}

export async function processPlanLifecycle(now: Date = new Date()): Promise<PlanLifecycleResult> {
  const mode = planLifecycleMode();
  const result: PlanLifecycleResult = { mode, downgraded: 0, wouldDowngrade: 0, remindersSent: 0, wouldRemind: 0 };
  if (mode === "off") return result;

  // 1. Plans whose paid period and grace window are over.
  const lapsed = await query<TenantRow>(
    `SELECT id, name, plan, plan_expires_at
     FROM tenants
     WHERE plan <> 'free' AND plan_expires_at IS NOT NULL
       AND plan_expires_at < $1::timestamptz - make_interval(days => $2::int)
     ORDER BY plan_expires_at
     LIMIT ${MAX_PER_RUN}`,
    [now.toISOString(), graceDays()]
  );

  for (const tenant of lapsed) {
    const liveSubscription = await queryOne<{ status: string }>(
      "SELECT status FROM tenant_subscriptions WHERE tenant_id = $1 AND status IN ('active', 'past_due') LIMIT 1",
      [tenant.id]
    );
    if (mode === "warn") {
      result.wouldDowngrade += 1;
      log.warn("[warn mode] would move this workspace to the Free plan: its paid period ended", {
        tenantId: tenant.id,
        plan: tenant.plan,
        endedAt: tenant.plan_expires_at,
        subscriptionStatus: liveSubscription?.status ?? null,
      });
      continue;
    }

    // The plan guard stops a workspace that renewed a moment ago from being downgraded.
    const moved = await queryOne<{ id: string }>(
      `UPDATE tenants SET plan_status = 'expired', updated_at = now()
       WHERE id = $1 AND plan = $2 AND plan_expires_at < $3::timestamptz - make_interval(days => $4::int)
       RETURNING id`,
      [tenant.id, tenant.plan, now.toISOString(), graceDays()]
    );
    if (!moved) continue;
    await updateTenantSubscriptionLifecycle({ tenantId: tenant.id, planId: "free", planStatus: "expired" });
    result.downgraded += 1;

    if (liveSubscription?.status === "active") {
      // The provider still shows it renewing but we never recorded the payment: most likely a lost webhook.
      log.error("workspace downgraded although its subscription is still active: a renewal webhook was probably missed", {
        tenantId: tenant.id,
      });
    }
    await AuditService.record({
      tenantId: tenant.id,
      action: "plan.expired",
      resourceType: "subscription",
      resourceId: tenant.id,
      details: { previousPlan: tenant.plan, endedAt: tenant.plan_expires_at },
    }).catch((err) => log.error("could not write the audit entry for an expired plan", { reason: (err as Error)?.message }));

    const email = await ownerEmail(tenant.id);
    if (email) {
      emailService
        .sendPlanExpired({ to: email, tenantName: tenant.name, planName: tenant.plan })
        .catch((err) => log.error("could not send the plan-expired email", { reason: (err as Error)?.message }));
    }
  }

  // 2. Prepaid plans (no automatic renewal) ending soon: one reminder per expiry date.
  const ending = await query<TenantRow>(
    `SELECT t.id, t.name, t.plan, t.plan_expires_at
     FROM tenants t
     WHERE t.plan <> 'free' AND t.plan_expires_at IS NOT NULL
       AND t.plan_expires_at > $1::timestamptz
       AND t.plan_expires_at <= $1::timestamptz + make_interval(days => $2::int)
       AND t.expiry_reminder_for IS DISTINCT FROM t.plan_expires_at
       AND NOT EXISTS (
         SELECT 1 FROM tenant_subscriptions s
         WHERE s.tenant_id = t.id AND s.status = 'active' AND s.cancel_at_period_end = false
       )
     ORDER BY t.plan_expires_at
     LIMIT ${MAX_PER_RUN}`,
    [now.toISOString(), reminderDays()]
  );

  for (const tenant of ending) {
    if (mode === "warn") {
      result.wouldRemind += 1;
      continue;
    }
    const email = await ownerEmail(tenant.id);
    if (email) {
      await emailService
        .sendPlanExpiringSoon({
          to: email,
          tenantName: tenant.name,
          planName: tenant.plan,
          expiresAt: new Date(tenant.plan_expires_at).toISOString(),
        })
        .catch((err) => log.error("could not send the plan-ending email", { reason: (err as Error)?.message }));
    }
    // Marked even without an owner email, so the job does not retry the same workspace forever.
    await query("UPDATE tenants SET expiry_reminder_for = plan_expires_at WHERE id = $1", [tenant.id]);
    result.remindersSent += 1;
  }

  return result;
}
