import { query, queryOne, withTransaction } from "../../db/pool";
import { BroadcastDefinition, DripDefinition, DripStep, FlowCampaignDefinition } from "./campaigns.types";
import { getContactIdsByFilter } from "../contacts/contacts.service";
import { getDripSchedulerStatus } from "./drip-scheduler-status";

export interface Campaign {
  id: string;
  tenant_id: string;
  channel_id: string;
  name: string;
  type: "broadcast" | "drip" | "flow";
  definition: BroadcastDefinition | DripDefinition | FlowCampaignDefinition;
  status: "draft" | "sending" | "completed" | "partially_failed" | "failed";
  total_recipients?: number;
  /** Accepted by the provider, no delivery receipt yet */
  sent_count?: number;
  /** Provider confirmed delivery to the handset (not yet read) */
  delivered_count?: number;
  read_count?: number;
  completed_count?: number;
  failed_count?: number;
  pending_count?: number;
  channel_type?: string;
  channel_display_name?: string;
  flow_name?: string;
  flow_status?: string;
  created_at: string;
}

export interface CampaignRecipient {
  id: string;
  campaign_id: string;
  contact_id: string;
  status: "pending" | "sent" | "delivered" | "read" | "failed" | "completed";
  current_step: number;
  /** Drip only: number of steps in the campaign, so the UI can show "1 of 2" */
  steps_total?: number;
  next_send_at: string;
  last_error: string | null;
  error_code?: string | null;
  provider_message_id?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  failed_at?: string | null;
  updated_at: string;
  contact_name?: string | null;
  contact_external_id?: string;
  contact_email?: string | null;
  contact_attributes?: Record<string, any>;
  conversation_id?: string | null;
}

/**
 * Creates the campaign plus one campaign_recipients row per targeted contact.
 * Audience can be supplied as an explicit contactIds array OR resolved dynamically
 * via tag / channel filtering.
 */
export async function createCampaign(params: {
  tenantId: string;
  channelId: string;
  name: string;
  type: "broadcast" | "drip" | "flow";
  definition: BroadcastDefinition | DripDefinition | FlowCampaignDefinition;
  contactIds?: string[];
  tags?: string[];
}): Promise<Campaign> {
  const { tenantId, channelId, name, type, definition, tags } = params;
  let contactIds = params.contactIds || [];

  // If no explicit contact IDs are given, resolve from audience tags
  if (contactIds.length === 0) {
    const audienceTags = tags || (definition as any)?.tags;
    contactIds = await getContactIdsByFilter(tenantId, { channelId, tags: audienceTags });
  }

  if (contactIds.length === 0) {
    throw new Error("No contacts match the specified audience criteria or tag filter");
  }

  return withTransaction(async (client) => {
    const campaignResult = await client.query(
      `INSERT INTO campaigns (tenant_id, channel_id, name, type, definition)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [tenantId, channelId, name, type, definition]
    );
    const campaign = campaignResult.rows[0] as Campaign;

    for (const contactId of contactIds) {
      await client.query(
        `INSERT INTO campaign_recipients (campaign_id, contact_id, next_send_at)
         VALUES ($1, $2, now())
         ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
        [campaign.id, contactId]
      );
    }

    campaign.total_recipients = contactIds.length;
    campaign.sent_count = 0;
    campaign.failed_count = 0;

    return campaign;
  });
}

/** Per-status recipient counts shared by the campaign list and details queries. */
const RECIPIENT_COUNTS_SQL = `
      COUNT(cr.id)::int as total_recipients,
      COUNT(CASE WHEN cr.status = 'sent' THEN 1 END)::int as sent_count,
      COUNT(CASE WHEN cr.status = 'delivered' THEN 1 END)::int as delivered_count,
      COUNT(CASE WHEN cr.status = 'read' THEN 1 END)::int as read_count,
      COUNT(CASE WHEN cr.status = 'completed' THEN 1 END)::int as completed_count,
      COUNT(CASE WHEN cr.status = 'failed' THEN 1 END)::int as failed_count,
      COUNT(CASE WHEN cr.status = 'pending' THEN 1 END)::int as pending_count`;

/**
 * Delivery receipts keep arriving after a send run ends, so the stored status (set when the
 * send loop finished) can go stale: a campaign stored as "completed" whose messages all turned
 * out undeliverable must read as failed. Derive the outcome from the live recipient counts for
 * finished broadcast/flow campaigns; draft/sending campaigns and drips keep their stored status.
 */
function withLiveStatus<T extends Campaign>(campaign: T): T {
  const finished = ["completed", "partially_failed", "failed"].includes(campaign.status);
  if (!finished || campaign.type === "drip") return campaign;
  const total = campaign.total_recipients || 0;
  const failed = campaign.failed_count || 0;
  if (total > 0 && failed >= total) return { ...campaign, status: "failed" };
  if (failed > 0) return { ...campaign, status: "partially_failed" };
  return { ...campaign, status: "completed" };
}

export async function getCampaign(tenantId: string, campaignId: string): Promise<Campaign | null> {
  const sql = `
    SELECT
      c.*,
      ch.type AS channel_type,
      ch.display_name AS channel_display_name,
      ${RECIPIENT_COUNTS_SQL}
    FROM campaigns c
    LEFT JOIN channels ch ON ch.id = c.channel_id
    LEFT JOIN campaign_recipients cr ON cr.campaign_id = c.id
    WHERE c.id = $1 AND c.tenant_id = $2
    GROUP BY c.id, ch.type, ch.display_name
  `;
  const stored = await queryOne<Campaign>(sql, [campaignId, tenantId]);
  if (!stored) return null;
  const campaign = withLiveStatus(stored);

  // If this is a flow campaign or has a flowId, look up the flow name and status
  const flowId = (campaign.definition as any)?.flowId;
  if (flowId && typeof flowId === "string") {
    try {
      const flow = await queryOne<{ name: string; status: string }>(
        "SELECT name, status FROM flows WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL",
        [flowId, tenantId]
      );
      if (flow) {
        campaign.flow_name = flow.name;
        campaign.flow_status = flow.status;
      }
    } catch {}
  }

  return campaign;
}

export async function deleteCampaign(tenantId: string, campaignId: string): Promise<boolean> {
  const res = await query(
    "DELETE FROM campaigns WHERE id = $1 AND tenant_id = $2 RETURNING id",
    [campaignId, tenantId]
  );
  return res.length > 0;
}

/**
 * Used only by the cross-tenant drip poller (processDueDripSteps), which by
 * design has no single tenant context to scope by — it's finding due work
 * across every tenant at once. Every other caller must use getCampaign
 * above and pass a verified tenantId.
 */
export async function getCampaignByIdUnscoped(campaignId: string): Promise<Campaign | null> {
  return queryOne<Campaign>("SELECT * FROM campaigns WHERE id = $1", [campaignId]);
}

export async function listCampaigns(tenantId: string): Promise<Campaign[]> {
  const rows = await query<Campaign>(
    `SELECT c.*,
       ch.type AS channel_type,
       ch.display_name AS channel_display_name,
       ${RECIPIENT_COUNTS_SQL}
     FROM campaigns c
     LEFT JOIN channels ch ON ch.id = c.channel_id
     LEFT JOIN campaign_recipients cr ON cr.campaign_id = c.id
     WHERE c.tenant_id = $1
     GROUP BY c.id, ch.type, ch.display_name
     ORDER BY c.created_at DESC`,
    [tenantId]
  );
  return rows.map(withLiveStatus);
}

export async function getCampaignRecipients(
  tenantId: string,
  campaignId: string,
  options: { status?: string; search?: string; limit?: number; offset?: number } = {}
): Promise<{ recipients: CampaignRecipient[]; total: number }> {
  // First verify campaign belongs to tenant
  const campaign = await queryOne<{ id: string; channel_id: string; definition: Partial<DripDefinition> }>(
    "SELECT id, channel_id, definition FROM campaigns WHERE id = $1 AND tenant_id = $2",
    [campaignId, tenantId]
  );
  if (!campaign) return { recipients: [], total: 0 };
  const stepsTotal = campaign.definition?.steps?.length ?? 0;

  const { status, search, limit = 50, offset = 0 } = options;
  const conditions = ["cr.campaign_id = $1"];
  const params: any[] = [campaignId];

  if (status && status !== "all") {
    params.push(status);
    conditions.push(`cr.status = $${params.length}`);
  }

  if (search && search.trim()) {
    params.push(`%${search.trim().toLowerCase()}%`);
    conditions.push(`(LOWER(ct.name) LIKE $${params.length} OR LOWER(ct.external_id) LIKE $${params.length})`);
  }

  // Count total matching
  const countSql = `
    SELECT COUNT(cr.id)::int AS count
    FROM campaign_recipients cr
    JOIN contacts ct ON ct.id = cr.contact_id
    WHERE ${conditions.join(" AND ")}
  `;
  const countResult = await queryOne<{ count: number }>(countSql, params);
  const total = countResult?.count || 0;

  // Query paginated rows
  // Tenant and channel are bound (never interpolated) and scope the latest-conversation lookup.
  const queryParams = [...params, tenantId, campaign.channel_id, limit, offset];
  const tenantParam = `$${queryParams.length - 3}`;
  const channelParam = `$${queryParams.length - 2}`;
  const limitParam = `$${queryParams.length - 1}`;
  const offsetParam = `$${queryParams.length}`;

  const sql = `
    SELECT
      cr.id,
      cr.campaign_id,
      cr.contact_id,
      cr.status,
      cr.current_step,
      cr.next_send_at,
      cr.last_error,
      cr.error_code,
      cr.provider_message_id,
      cr.delivered_at,
      cr.read_at,
      cr.failed_at,
      cr.updated_at,
      ct.name AS contact_name,
      ct.external_id AS contact_external_id,
      (ct.attributes->>'email') AS contact_email,
      ct.attributes AS contact_attributes,
      conv.id AS conversation_id
    FROM campaign_recipients cr
    JOIN contacts ct ON ct.id = cr.contact_id
    LEFT JOIN LATERAL (
      SELECT id FROM conversations
      WHERE contact_id = cr.contact_id AND tenant_id = ${tenantParam} AND channel_id = ${channelParam}
      ORDER BY created_at DESC LIMIT 1
    ) conv ON true
    WHERE ${conditions.join(" AND ")}
    ORDER BY
      CASE WHEN cr.status = 'failed' THEN 1 WHEN cr.status = 'pending' THEN 2 ELSE 3 END,
      cr.updated_at DESC
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;

  const recipients = await query<CampaignRecipient>(sql, queryParams);
  return {
    recipients: stepsTotal > 0 ? recipients.map((r) => ({ ...r, steps_total: stepsTotal })) : recipients,
    total,
  };
}

export interface DripProgressRow {
  current_step: number;
  status: CampaignRecipient["status"];
  count: number;
}

export interface DripStepProgress {
  stepIndex: number;
  sent: number;
  waiting: number;
  failed: number;
}

/**
 * Per-step outcome for a drip. `current_step` is the 0-based index of the step a recipient is
 * waiting for (or failed on), so a recipient at 1 has already received step 0; a completed
 * recipient stays at its last index but has received every step.
 */
export function buildDripProgress(
  stepCount: number,
  rows: DripProgressRow[]
): { progress: DripStepProgress[]; messagesSent: number } {
  const progress: DripStepProgress[] = Array.from({ length: stepCount }, (_, stepIndex) => ({
    stepIndex,
    sent: 0,
    waiting: 0,
    failed: 0,
  }));

  for (const { current_step, status, count } of rows) {
    const reached = status === "completed" ? stepCount : Math.min(current_step, stepCount);
    for (let i = 0; i < reached; i++) progress[i].sent += count;
    if (reached < stepCount && status === "pending") progress[reached].waiting += count;
    if (reached < stepCount && status === "failed") progress[reached].failed += count;
  }

  return { progress, messagesSent: progress.reduce((sum, step) => sum + step.sent, 0) };
}

export async function getCampaignAnalytics(tenantId: string, campaignId: string): Promise<any | null> {
  const campaign = await getCampaign(tenantId, campaignId);
  if (!campaign) return null;

  // Step breakdown for Drip campaigns
  const stepStats = await query<{ step: number; count: number }>(
    `SELECT current_step AS step, COUNT(id)::int AS count
     FROM campaign_recipients
     WHERE campaign_id = $1
     GROUP BY current_step
     ORDER BY current_step ASC`,
    [campaignId]
  );

  // Status breakdown
  const statusStats = await query<{ status: string; count: number }>(
    `SELECT status, COUNT(id)::int AS count
     FROM campaign_recipients
     WHERE campaign_id = $1
     GROUP BY status`,
    [campaignId]
  );

  // Why messages failed (provider error code + reason), most common first
  const failureReasons = await query<{ error_code: string | null; reason: string; count: number }>(
    `SELECT error_code, COALESCE(NULLIF(last_error, ''), 'Unknown error') AS reason, COUNT(id)::int AS count
     FROM campaign_recipients
     WHERE campaign_id = $1 AND status = 'failed'
     GROUP BY error_code, COALESCE(NULLIF(last_error, ''), 'Unknown error')
     ORDER BY count DESC
     LIMIT 10`,
    [campaignId]
  );

  const total = campaign.total_recipients || 0;
  const sent = campaign.sent_count || 0; // accepted by provider, no receipt yet
  const delivered = campaign.delivered_count || 0;
  const read = campaign.read_count || 0;
  const completed = campaign.completed_count || 0; // drip: every step sent (no receipts tracked)
  const failed = campaign.failed_count || 0;
  const pending = campaign.pending_count || 0;
  // "Delivered" only counts what the provider actually confirmed; plain "sent" is not delivery.
  const deliveredTotal = delivered + read;
  const acceptedTotal = sent + deliveredTotal + completed;

  const deliveryRate = total > 0 ? Math.round((deliveredTotal / total) * 100) : 0;
  const acceptedRate = total > 0 ? Math.round((acceptedTotal / total) * 100) : 0;
  const failureRate = total > 0 ? Math.round((failed / total) * 100) : 0;
  const pendingRate = total > 0 ? Math.round((pending / total) * 100) : 0;

  const drip =
    campaign.type === "drip"
      ? buildDripProgress(
          (campaign.definition as Partial<DripDefinition>).steps?.length ?? 0,
          await query<DripProgressRow>(
            `SELECT current_step, status, COUNT(id)::int AS count
             FROM campaign_recipients
             WHERE campaign_id = $1
             GROUP BY current_step, status`,
            [campaignId]
          )
        )
      : null;

  return {
    campaign,
    ...(drip ? { dripProgress: drip.progress, messagesSent: drip.messagesSent } : {}),
    ...(campaign.type === "drip" ? { scheduler: getDripSchedulerStatus() } : {}),
    metrics: {
      totalRecipients: total,
      sentCount: sent,
      deliveredCount: delivered,
      readCount: read,
      completedCount: completed,
      deliveredTotal,
      acceptedTotal,
      failedCount: failed,
      pendingCount: pending,
      deliveryRate,
      acceptedRate,
      failureRate,
      pendingRate,
    },
    statusBreakdown: statusStats,
    stepBreakdown: stepStats,
    failureReasons: failureReasons.map((r) => ({ errorCode: r.error_code, reason: r.reason, count: r.count })),
  };
}

export async function setCampaignStatus(campaignId: string, status: Campaign["status"]): Promise<void> {
  await query("UPDATE campaigns SET status = $1 WHERE id = $2", [status, campaignId]);
}

export async function getRecipientsByStatus(
  campaignId: string,
  status: CampaignRecipient["status"]
): Promise<(CampaignRecipient & { external_id: string; name: string | null; attributes?: any })[]> {
  return query(
    `SELECT cr.*, c.external_id, c.name, c.attributes
     FROM campaign_recipients cr
     JOIN contacts c ON c.id = cr.contact_id
     WHERE cr.campaign_id = $1 AND cr.status = $2`,
    [campaignId, status]
  );
}

/** Every recipient row (across all campaigns) whose next scheduled send is due now. */
export async function getDueDripRecipients(): Promise<
  (CampaignRecipient & { external_id: string; name: string | null; attributes?: any; campaign_id: string })[]
> {
  return query(
    `SELECT cr.*, c.external_id, c.name, c.attributes
     FROM campaign_recipients cr
     JOIN contacts c ON c.id = cr.contact_id
     JOIN campaigns camp ON camp.id = cr.campaign_id
     WHERE camp.type = 'drip' AND camp.status = 'sending'
       AND cr.status = 'pending' AND cr.next_send_at <= now()`
  );
}

/**
 * Starts a draft drip campaign: moves it to 'sending' and schedules every pending recipient's
 * first step (honouring step 1's delay). Saves the normalized steps too, so drips created before
 * the `message` -> `text` fix run correctly. Returns null when the campaign is not a draft
 * (already started), which makes a double click harmless.
 */
export async function startDripCampaign(params: {
  tenantId: string;
  campaignId: string;
  steps: DripStep[];
}): Promise<{ scheduled: number } | null> {
  const { tenantId, campaignId, steps } = params;
  return withTransaction(async (client) => {
    const started = await client.query(
      `UPDATE campaigns
       SET status = 'sending', definition = jsonb_set(definition, '{steps}', $3::jsonb)
       WHERE id = $1 AND tenant_id = $2 AND type = 'drip' AND status = 'draft'
       RETURNING id`,
      [campaignId, tenantId, JSON.stringify(steps)]
    );
    if (started.rows.length === 0) return null;

    const scheduled = await client.query(
      `UPDATE campaign_recipients
       SET next_send_at = now() + ($2::float8 * interval '1 hour'), updated_at = now()
       WHERE campaign_id = $1 AND status = 'pending'`,
      [campaignId, steps[0].delayHours]
    );
    return { scheduled: scheduled.rowCount ?? 0 };
  });
}

/**
 * Closes drip campaigns whose recipients have all finished (no step still pending):
 * completed, partially_failed, or failed when every recipient failed.
 */
export async function finalizeFinishedDripCampaigns(): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE campaigns c
     SET status = CASE
       WHEN t.failed = 0 THEN 'completed'
       WHEN t.failed >= t.total THEN 'failed'
       ELSE 'partially_failed'
     END
     FROM (
       SELECT cr.campaign_id,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE cr.status = 'failed')::int AS failed,
              COUNT(*) FILTER (WHERE cr.status = 'pending')::int AS pending
       FROM campaign_recipients cr
       JOIN campaigns camp ON camp.id = cr.campaign_id
       WHERE camp.type = 'drip' AND camp.status = 'sending'
       GROUP BY cr.campaign_id
     ) t
     WHERE c.id = t.campaign_id AND t.pending = 0
     RETURNING c.id`
  );
  return rows.length;
}

/**
 * A broadcast recipient sends exactly once — mark it sent (accepted by the provider).
 * The provider message id lets later delivery receipts find this row.
 */
export async function markBroadcastSent(recipientId: string, providerMessageId?: string): Promise<void> {
  await query(
    `UPDATE campaign_recipients
     SET status = 'sent', provider_message_id = $2, last_error = NULL, error_code = NULL, updated_at = now()
     WHERE id = $1`,
    [recipientId, providerMessageId ?? null]
  );
}

type ReceiptStatus = "sent" | "delivered" | "read" | "failed";

/**
 * Applies a provider delivery receipt (webhook) to the campaign recipient that
 * owns the provider message id. Scoped to the tenant that owns the channel the
 * webhook arrived on, and monotonic so out-of-order receipts never downgrade a row:
 *   sent -> delivered -> read   (a 'read' receipt may skip 'delivered')
 *   sent -> failed              (a failure after delivery/read is ignored)
 * Returns true when a campaign recipient was updated, false if the id isn't one of ours.
 */
export async function applyDeliveryReceipt(params: {
  tenantId: string;
  providerMessageId: string;
  status: ReceiptStatus;
  errorCode?: string;
  errorMessage?: string;
  timestamp: Date;
}): Promise<boolean> {
  const { tenantId, providerMessageId, status, errorCode, errorMessage, timestamp } = params;

  if (status === "sent") return false; // 'sent' is the ack we already recorded at send time

  let sql: string;
  let values: any[];
  if (status === "failed") {
    sql = `UPDATE campaign_recipients cr
           SET status = 'failed', last_error = $3, error_code = $4, failed_at = $5, updated_at = now()
           FROM campaigns c
           WHERE cr.provider_message_id = $1 AND c.id = cr.campaign_id AND c.tenant_id = $2
             AND cr.status = 'sent'
           RETURNING cr.id`;
    values = [providerMessageId, tenantId, errorMessage || errorCode || "Delivery failed", errorCode ?? null, timestamp];
  } else if (status === "delivered") {
    sql = `UPDATE campaign_recipients cr
           SET status = 'delivered', delivered_at = $3, updated_at = now()
           FROM campaigns c
           WHERE cr.provider_message_id = $1 AND c.id = cr.campaign_id AND c.tenant_id = $2
             AND cr.status = 'sent'
           RETURNING cr.id`;
    values = [providerMessageId, tenantId, timestamp];
  } else {
    sql = `UPDATE campaign_recipients cr
           SET status = 'read', read_at = $3, delivered_at = COALESCE(cr.delivered_at, $3), updated_at = now()
           FROM campaigns c
           WHERE cr.provider_message_id = $1 AND c.id = cr.campaign_id AND c.tenant_id = $2
             AND cr.status IN ('sent', 'delivered')
           RETURNING cr.id`;
    values = [providerMessageId, tenantId, timestamp];
  }

  const rows = await query<{ id: string }>(sql, values);
  return rows.length > 0;
}

/** A drip recipient just received one step's message; schedule the next one. */
export async function advanceDripRecipient(
  recipientId: string,
  nextStep: number,
  nextSendAt: Date
): Promise<void> {
  await query(
    `UPDATE campaign_recipients
     SET current_step = $1, next_send_at = $2, updated_at = now()
     WHERE id = $3`,
    [nextStep, nextSendAt, recipientId]
  );
}

/** A drip recipient has received its final step. */
export async function completeDripRecipient(recipientId: string): Promise<void> {
  await query(
    "UPDATE campaign_recipients SET status = 'completed', updated_at = now() WHERE id = $1",
    [recipientId]
  );
}

export async function markRecipientFailed(recipientId: string, error: string): Promise<void> {
  await query(
    "UPDATE campaign_recipients SET status = 'failed', last_error = $1, updated_at = now() WHERE id = $2",
    [error, recipientId]
  );
}
