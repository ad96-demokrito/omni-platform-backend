import type { PoolClient } from "pg";
import { query, queryOne, withTransaction } from "../../db/pool";
import { emitRealtimeEvent } from "../realtime/websocket.service";
import { AuditService } from "../audit/audit.service";
import { ASSIGNABLE_ROLES } from "../teams/teams.service";
import { httpError, isUuid } from "../../utils/http-error";
import { logger } from "../../utils/logger";

const log = logger.child({ module: "conversations-service" });

export const CONVERSATION_STATUSES = ["open", "pending", "closed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export interface Conversation {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  status: string;
  assigned_agent_id: string | null;
  assigned_team_id?: string | null;
  last_message_at: string | null;
  last_inbound_at?: string | null;
  created_at: string;
}

export interface SessionWindow {
  isOpen: boolean;
  expiresAt: string | null;
  secondsRemaining: number;
  isExpired: boolean;
  lastInboundAt: string | null;
}

/** Who performed a change; recorded in the audit log. */
export interface ConversationActor {
  userId: string;
  email?: string;
  ipAddress?: string;
}

export interface ConversationFilters {
  status?: ConversationStatus;
  /** A user id, or "unassigned". */
  assignedTo?: string;
  teamId?: string;
  /** Only conversations routed to a team this user belongs to ("My teams"). */
  teamsOfUserId?: string;
}

export function computeSessionWindow(
  lastInboundAt: string | Date | null | undefined,
  channelType: string = "whatsapp"
): SessionWindow {
  if (channelType !== "whatsapp") {
    return {
      isOpen: true,
      expiresAt: null,
      secondsRemaining: 86400,
      isExpired: false,
      lastInboundAt: lastInboundAt ? new Date(lastInboundAt).toISOString() : null,
    };
  }

  if (!lastInboundAt) {
    return {
      isOpen: false,
      expiresAt: null,
      secondsRemaining: 0,
      isExpired: true,
      lastInboundAt: null,
    };
  }

  const inboundDate = new Date(lastInboundAt);
  const inboundTime = inboundDate.getTime();
  if (isNaN(inboundTime)) {
    return {
      isOpen: false,
      expiresAt: null,
      secondsRemaining: 0,
      isExpired: true,
      lastInboundAt: null,
    };
  }

  const now = Date.now();
  const windowDurationMs = 24 * 60 * 60 * 1000;
  const expiresTime = inboundTime + windowDurationMs;
  const secondsRemaining = Math.max(0, Math.floor((expiresTime - now) / 1000));
  const isExpired = now > expiresTime;

  return {
    isOpen: !isExpired,
    expiresAt: new Date(expiresTime).toISOString(),
    secondsRemaining,
    isExpired,
    lastInboundAt: new Date(inboundTime).toISOString(),
  };
}

/**
 * One conversation per contact. A non-closed one is always preferred. With `reuseClosed` (customer
 * message paths) the contact's latest closed conversation is returned instead of starting a new one;
 * it is reopened by `reopenOnCustomerMessage` once the message is actually stored, so a retried
 * webhook for an old message cannot reopen it. Campaign sends leave `reuseClosed` off: a marketing
 * blast must not reopen a resolved support case.
 */
export async function findOrCreateOpenConversation(params: {
  tenantId: string;
  contactId: string;
  channelId: string;
  reuseClosed?: boolean;
}): Promise<Conversation> {
  const { tenantId, contactId, channelId, reuseClosed = false } = params;

  const existing = await queryOne<Conversation>(
    `SELECT * FROM conversations
     WHERE contact_id = $1 AND tenant_id = $2 AND ($3::boolean OR status != 'closed')
     ORDER BY (status = 'closed') ASC, COALESCE(last_message_at, created_at) DESC
     LIMIT 1`,
    [contactId, tenantId, reuseClosed]
  );
  if (existing) return existing;

  const created = await queryOne<Conversation>(
    `INSERT INTO conversations (tenant_id, contact_id, channel_id, status)
     VALUES ($1, $2, $3, 'open') RETURNING *`,
    [tenantId, contactId, channelId]
  );
  return created!;
}

export async function touchLastMessageAt(conversationId: string) {
  await query("UPDATE conversations SET last_message_at = now() WHERE id = $1", [conversationId]);
}

export async function touchLastInboundAt(conversationId: string, timestamp: Date = new Date()) {
  await query(
    "UPDATE conversations SET last_message_at = $1, last_inbound_at = $1 WHERE id = $2",
    [timestamp, conversationId]
  );
}

interface ConversationRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  status: string;
  assigned_agent_id: string | null;
  assigned_team_id: string | null;
  last_message_at: Date | string | null;
  last_inbound_at: Date | string | null;
  created_at: Date | string | null;
  contact_name: string | null;
  contact_external_id: string | null;
  channel_type: string | null;
  channel_display_name: string | null;
  assigned_agent_name: string | null;
  assigned_team_name: string | null;
  bot_paused: boolean;
  handoff_at: Date | string | null;
  handoff_reason: string | null;
  handoff_priority: string | null;
  handoff_flow_name: string | null;
  /** Only selected by the detail query (it can be a few KB). */
  handoff_context?: Record<string, unknown> | null;
}

const CONVERSATION_COLUMNS = `
    c.id,
    c.tenant_id,
    c.contact_id,
    c.channel_id,
    c.status,
    c.assigned_agent_id,
    c.assigned_team_id,
    c.last_message_at,
    c.last_inbound_at,
    c.created_at,
    c.bot_paused,
    c.handoff_at,
    c.handoff_reason,
    c.handoff_priority,
    c.handoff_flow_name,
    ct.name AS contact_name,
    ct.external_id AS contact_external_id,
    ch.type AS channel_type,
    ch.display_name AS channel_display_name,
    COALESCE(u.name, u.email) AS assigned_agent_name,
    tm.name AS assigned_team_name`;

const CONVERSATION_FROM = `
  FROM conversations c
  LEFT JOIN contacts ct ON ct.id = c.contact_id
  LEFT JOIN channels ch ON ch.id = c.channel_id
  LEFT JOIN users u ON u.id = c.assigned_agent_id AND u.tenant_id = c.tenant_id
  LEFT JOIN teams tm ON tm.id = c.assigned_team_id AND tm.tenant_id = c.tenant_id`;

/** Columns + joins shared by the conversation list and detail queries. */
const CONVERSATION_SELECT_SQL = `SELECT ${CONVERSATION_COLUMNS} ${CONVERSATION_FROM}`;
const CONVERSATION_DETAIL_SELECT_SQL = `SELECT ${CONVERSATION_COLUMNS}, c.handoff_context ${CONVERSATION_FROM}`;

const toIso = (value: Date | string | null): string | null =>
  value ? new Date(value).toISOString() : null;

function mapConversationRow(r: ConversationRow) {
  const sessionWindow = computeSessionWindow(r.last_inbound_at, r.channel_type ?? undefined);
  return {
    id: r.id,
    tenantId: r.tenant_id,
    tenant_id: r.tenant_id,
    contactId: r.contact_id,
    contact_id: r.contact_id,
    channelId: r.channel_id,
    channel_id: r.channel_id,
    status: r.status,
    assignedAgentUserId: r.assigned_agent_id,
    assigned_agent_id: r.assigned_agent_id,
    assignedAgentName: r.assigned_agent_name,
    assignedTeamId: r.assigned_team_id,
    assignedTeamName: r.assigned_team_name,
    botPaused: r.bot_paused === true,
    handoffAt: toIso(r.handoff_at),
    handoffReason: r.handoff_reason,
    handoffPriority: r.handoff_priority,
    handoffFlowName: r.handoff_flow_name,
    handoffContext: r.handoff_context ?? null,
    lastMessageAt: toIso(r.last_message_at),
    last_message_at: toIso(r.last_message_at),
    lastInboundAt: toIso(r.last_inbound_at),
    last_inbound_at: toIso(r.last_inbound_at),
    sessionWindow,
    session_window: sessionWindow,
    createdAt: toIso(r.created_at),
    created_at: toIso(r.created_at),
    contactName: r.contact_name || null,
    contact_name: r.contact_name || null,
    contactExternalId: r.contact_external_id || null,
    contact_external_id: r.contact_external_id || null,
    channelType: r.channel_type || "whatsapp",
    channel_type: r.channel_type || "whatsapp",
    channelDisplayName: r.channel_display_name || null,
    channel_display_name: r.channel_display_name || null,
  };
}

export type ConversationView = ReturnType<typeof mapConversationRow>;

export async function listConversations(
  tenantId: string,
  filters: ConversationFilters = {}
): Promise<Array<ConversationView & { lastMessageText: string; last_message_text: string }>> {
  const conditions = ["c.tenant_id = $1"];
  const params: unknown[] = [tenantId];

  if (filters.status) {
    params.push(filters.status);
    conditions.push(`c.status = $${params.length}`);
  }
  if (filters.assignedTo === "unassigned") {
    conditions.push("c.assigned_agent_id IS NULL");
  } else if (filters.assignedTo) {
    params.push(filters.assignedTo);
    conditions.push(`c.assigned_agent_id = $${params.length}`);
  }
  if (filters.teamId) {
    params.push(filters.teamId);
    conditions.push(`c.assigned_team_id = $${params.length}`);
  }
  if (filters.teamsOfUserId) {
    params.push(filters.teamsOfUserId);
    conditions.push(
      `c.assigned_team_id IN (
         SELECT tm_mine.team_id FROM team_members tm_mine
         WHERE tm_mine.user_id = $${params.length} AND tm_mine.tenant_id = c.tenant_id
       )`
    );
  }

  const sql = `
    ${CONVERSATION_SELECT_SQL}
    WHERE ${conditions.join(" AND ")}
    ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
  `;

  const rows = await query<ConversationRow>(sql, params);
  if (rows.length === 0) return [];

  // Fetch latest message text from MongoDB for each conversation
  const convIds = rows.map((r) => r.id);
  const latestMessageMap: Record<string, string> = {};

  try {
    const { getMongoDb } = await import("../../db/mongo");
    const db = await getMongoDb();
    const messagesCol = db.collection("messages");

    const latestDocs = await messagesCol
      .aggregate([
        { $match: { conversationId: { $in: convIds } } },
        { $sort: { sentAt: -1 } },
        {
          $group: {
            _id: "$conversationId",
            content: { $first: "$content" },
            type: { $first: "$type" },
          },
        },
      ])
      .toArray();

    for (const doc of latestDocs) {
      const text =
        doc.content?.text ||
        (typeof doc.content === "string" ? doc.content : "") ||
        (doc.type === "template" ? `[Template: ${doc.content?.templateName || ""}]` : "") ||
        (doc.type ? `[${doc.type}]` : "");
      latestMessageMap[doc._id] = text;
    }
  } catch (err) {
    // Non-fatal MongoDB aggregation fallback
    log.warn("Could not load latest message previews", { error: (err as Error).message });
  }

  return rows.map((r) => ({
    ...mapConversationRow(r),
    lastMessageText: latestMessageMap[r.id] || "",
    last_message_text: latestMessageMap[r.id] || "",
  }));
}

/** `includeHandoffContext` adds the collected-variables snapshot; it is left out of lists and live updates. */
export async function getConversation(
  tenantId: string,
  conversationId: string,
  options: { includeHandoffContext?: boolean } = {}
): Promise<ConversationView | null> {
  const select = options.includeHandoffContext ? CONVERSATION_DETAIL_SELECT_SQL : CONVERSATION_SELECT_SQL;
  const r = await queryOne<ConversationRow>(`${select} WHERE c.id = $1 AND c.tenant_id = $2`, [
    conversationId,
    tenantId,
  ]);
  return r ? mapConversationRow(r) : null;
}

/** Tells every open inbox the conversation changed; they merge the payload into their list. */
async function emitConversationUpdate(tenantId: string, conversationId: string): Promise<void> {
  try {
    const view = await getConversation(tenantId, conversationId);
    if (!view) return;
    await emitRealtimeEvent(tenantId, "conversation:update", view, { conversationId });

    // A webchat visitor never receives conversation:update (it names the assignee and team); they get
    // only who is answering them, first name only.
    if (view.channelType === "webchat") {
      const visitorState = await getVisitorHandoffState(tenantId, conversationId);
      await emitRealtimeEvent(tenantId, "conversation:agent", { conversationId, ...visitorState }, { conversationId });
    }
  } catch (err) {
    log.warn("Realtime conversation update failed", { error: (err as Error).message });
  }
}

function recordConversationAudit(
  tenantId: string,
  actor: ConversationActor,
  action: string,
  conversationId: string,
  details: Record<string, unknown>
): Promise<void> {
  return AuditService.record({
    tenantId,
    userId: actor.userId,
    userEmail: actor.email,
    action,
    resourceType: "conversation",
    resourceId: conversationId,
    details,
    ipAddress: actor.ipAddress,
  });
}

/** An assignee must be an active owner/admin/agent of *this* workspace (never a viewer). */
async function assertAssignableAgent(tenantId: string, userId: string): Promise<void> {
  const user = await queryOne<{ id: string }>(
    `SELECT id FROM users
     WHERE id = $1 AND tenant_id = $2 AND status = 'active' AND role = ANY($3::text[])`,
    [userId, tenantId, [...ASSIGNABLE_ROLES]]
  );
  if (!user) {
    throw httpError(400, "Assignee must be an active owner, admin or agent of this workspace");
  }
}

/** Assigns the conversation to an agent, or unassigns it when `agentUserId` is null. */
export async function assignAgent(
  tenantId: string,
  conversationId: string,
  agentUserId: string | null,
  actor: ConversationActor
): Promise<void> {
  if (agentUserId) await assertAssignableAgent(tenantId, agentUserId);

  // An assigned case is owned by that agent, so it leaves the "needs agent" queue (pending -> open).
  const updated = await queryOne<{ previous_agent_id: string | null }>(
    `UPDATE conversations c
     SET assigned_agent_id = $1::uuid,
         status = CASE WHEN $1::uuid IS NOT NULL AND c.status = 'pending' THEN 'open' ELSE c.status END
     FROM (SELECT id, assigned_agent_id FROM conversations WHERE id = $2 AND tenant_id = $3) prev
     WHERE c.id = prev.id
     RETURNING prev.assigned_agent_id AS previous_agent_id`,
    [agentUserId, conversationId, tenantId]
  );
  if (!updated) throw httpError(404, "Conversation not found");

  // Once a person owns the case the bot must stop answering.
  if (agentUserId) await pauseBotForConversation(tenantId, conversationId);

  await recordConversationAudit(
    tenantId,
    actor,
    agentUserId ? "conversation.assigned" : "conversation.unassigned",
    conversationId,
    { from: updated.previous_agent_id, to: agentUserId }
  );
  emitRealtimeEvent(
    tenantId,
    "conversation:assigned",
    { conversationId, assignedAgentUserId: agentUserId },
    { conversationId }
  ).catch((err) => log.warn("Realtime assign event failed", { error: err.message }));
  await emitConversationUpdate(tenantId, conversationId);
}

/** Routes the conversation to a support team, or clears the team when `teamId` is null. */
export async function assignTeam(
  tenantId: string,
  conversationId: string,
  teamId: string | null,
  actor: ConversationActor
): Promise<void> {
  if (teamId) {
    const team = await queryOne<{ id: string }>(
      "SELECT id FROM teams WHERE id = $1 AND tenant_id = $2",
      [teamId, tenantId]
    );
    if (!team) throw httpError(404, "Team not found");
  }

  const updated = await queryOne<{ previous_team_id: string | null }>(
    `UPDATE conversations c SET assigned_team_id = $1
     FROM (SELECT id, assigned_team_id FROM conversations WHERE id = $2 AND tenant_id = $3) prev
     WHERE c.id = prev.id
     RETURNING prev.assigned_team_id AS previous_team_id`,
    [teamId, conversationId, tenantId]
  );
  if (!updated) throw httpError(404, "Conversation not found");

  await recordConversationAudit(tenantId, actor, "conversation.team_assigned", conversationId, {
    from: updated.previous_team_id,
    to: teamId,
  });
  await emitConversationUpdate(tenantId, conversationId);

  // A waiting case just got a team: tell its members, like a flow hand-off to that team would.
  if (teamId) {
    const view = await getConversation(tenantId, conversationId);
    if (view && view.status === "pending" && !view.assignedAgentUserId) {
      await notifyHandoff(tenantId, view).catch((err) =>
        log.warn("Handoff notification failed", { error: (err as Error).message })
      );
    }
  }
}

/**
 * Takes an unassigned case for yourself (or confirms one you already hold). A single atomic
 * UPDATE decides the winner when two agents claim at once; the loser gets a 409.
 */
export async function claimConversation(
  tenantId: string,
  conversationId: string,
  actor: ConversationActor
): Promise<void> {
  await assertAssignableAgent(tenantId, actor.userId);

  const claimed = await queryOne<{ id: string }>(
    `UPDATE conversations
     SET assigned_agent_id = $1,
         status = CASE WHEN status = 'pending' THEN 'open' ELSE status END
     WHERE id = $2 AND tenant_id = $3 AND status <> 'closed'
       AND (assigned_agent_id IS NULL OR assigned_agent_id = $1)
     RETURNING id`,
    [actor.userId, conversationId, tenantId]
  );

  if (!claimed) {
    const current = await queryOne<{ status: string }>(
      "SELECT status FROM conversations WHERE id = $1 AND tenant_id = $2",
      [conversationId, tenantId]
    );
    if (!current) throw httpError(404, "Conversation not found");
    if (current.status === "closed") throw httpError(409, "This case is closed — reopen it first");
    throw httpError(409, "This case is already assigned to another agent");
  }

  await pauseBotForConversation(tenantId, conversationId);
  await recordConversationAudit(tenantId, actor, "conversation.claimed", conversationId, {});
  await emitConversationUpdate(tenantId, conversationId);
}

export async function updateConversationStatus(
  tenantId: string,
  conversationId: string,
  status: ConversationStatus,
  actor: ConversationActor
): Promise<void> {
  // Closing stamps the resolution time; reopening / pending clears it so SLA numbers stay true.
  const updated = await queryOne<{ previous_status: string }>(
    `UPDATE conversations c
     SET status = $1::text,
         resolved_at = CASE WHEN $1::text = 'closed' THEN COALESCE(c.resolved_at, now()) ELSE NULL END,
         resolution_duration_seconds = CASE
           WHEN $1::text = 'closed'
           THEN COALESCE(c.resolution_duration_seconds, EXTRACT(EPOCH FROM (now() - c.created_at))::INTEGER)
           ELSE NULL END
     FROM (SELECT id, status FROM conversations WHERE id = $2 AND tenant_id = $3) prev
     WHERE c.id = prev.id
     RETURNING prev.status AS previous_status`,
    [status, conversationId, tenantId]
  );
  if (!updated) throw httpError(404, "Conversation not found");

  if (status === "closed") {
    // Release the bot and handed_off / active flow runs so the next inbound message starts fresh.
    await releaseBot(tenantId, conversationId);
  }

  await recordConversationAudit(tenantId, actor, "conversation.status_changed", conversationId, {
    from: updated.previous_status,
    to: status,
  });
  // `changedByUserId` lets the person who clicked ignore their own status alert.
  emitRealtimeEvent(
    tenantId,
    "conversation:status",
    { conversationId, status, changedByUserId: actor.userId },
    { conversationId }
  ).catch((err) => log.warn("Realtime status event failed", { error: err.message }));
  await emitConversationUpdate(tenantId, conversationId);
}

export async function resumeBotForConversation(
  tenantId: string,
  conversationId: string,
  actor: ConversationActor
): Promise<void> {
  const conversation = await queryOne<{ id: string }>(
    "SELECT id FROM conversations WHERE id = $1 AND tenant_id = $2",
    [conversationId, tenantId]
  );
  if (!conversation) throw httpError(404, "Conversation not found");

  await releaseBot(tenantId, conversationId);

  await recordConversationAudit(tenantId, actor, "conversation.bot_resumed", conversationId, {});
  emitRealtimeEvent(tenantId, "conversation:bot_resumed", { conversationId }, { conversationId }).catch(
    (err) => log.warn("Realtime bot-resumed event failed", { error: err.message })
  );
  await emitConversationUpdate(tenantId, conversationId);
}

/**
 * Hands the conversation back to the bot: clears the pause and the hand-off details, and completes
 * handed_off / running flow runs so the next customer message starts the flow fresh from its entry.
 * Callers have already proven the conversation belongs to `tenantId`.
 */
async function releaseBot(tenantId: string, conversationId: string): Promise<void> {
  await query(
    `UPDATE conversations
     SET bot_paused = false, handoff_at = NULL, handoff_reason = NULL, handoff_priority = NULL,
         handoff_context = NULL, handoff_flow_name = NULL
     WHERE id = $1 AND tenant_id = $2`,
    [conversationId, tenantId]
  );
  await query(
    `UPDATE flow_runs SET status = 'completed', updated_at = now()
     WHERE conversation_id = $1 AND (status = 'handed_off' OR status = 'running')`,
    [conversationId]
  );
}

/**
 * A person now owns the case (assigned, claimed or replied): stop the bot answering. Idempotent;
 * closed cases are left alone. Used instead of inferring the pause from a running flow only.
 */
export async function pauseBotForConversation(tenantId: string, conversationId: string): Promise<void> {
  const paused = await queryOne<{ id: string }>(
    `UPDATE conversations SET bot_paused = true
     WHERE id = $1 AND tenant_id = $2 AND status <> 'closed' RETURNING id`,
    [conversationId, tenantId]
  );
  if (!paused) return;
  // Safe to key on conversation_id: the tenant-scoped UPDATE above already matched.
  await query(
    `UPDATE flow_runs SET status = 'handed_off', updated_at = now()
     WHERE conversation_id = $1 AND status = 'running'`,
    [conversationId]
  );
}

const MAX_HANDOFF_CONTEXT_BYTES = 4096;

export interface HandoffParams {
  tenantId: string;
  conversationId: string;
  teamId?: string;
  agentUserId?: string;
  assignMode: "default" | "auto" | "none";
  reason?: string;
  priority: "normal" | "high" | "urgent";
  /** Variables the flow collected, shown to the agent. Already stripped of internal keys by the caller. */
  context?: Record<string, unknown>;
  flowName?: string;
}

export interface HandoffOutcome {
  /** False when the case no longer exists or is already closed. */
  applied: boolean;
  handoffAt: Date | null;
  assignedAgentUserId: string | null;
  autoAssigned: boolean;
}

/** Keeps the stored snapshot small; an oversized one is dropped rather than truncated mid-value. */
function capHandoffContext(context: Record<string, unknown> | undefined): string | null {
  if (!context || Object.keys(context).length === 0) return null;
  const json = JSON.stringify(context);
  return json.length <= MAX_HANDOFF_CONTEXT_BYTES ? json : null;
}

async function shouldAutoAssign(
  client: PoolClient,
  tenantId: string,
  mode: HandoffParams["assignMode"]
): Promise<boolean> {
  if (mode === "none") return false;
  if (mode === "auto") return true;
  const res = await client.query<{ auto_assign_enabled: boolean }>(
    "SELECT auto_assign_enabled FROM tenants WHERE id = $1",
    [tenantId]
  );
  return res.rows[0]?.auto_assign_enabled === true;
}

/**
 * Least-busy auto-assign: among the active owners/admins/agents of this workspace (restricted to
 * the team's members when a team is given), take the one with the fewest open/pending cases; ties go
 * to whoever was auto-assigned longest ago. Returns null when nobody is eligible.
 * Call inside a transaction that holds the per-tenant advisory lock (see `handOffConversation`).
 */
export async function pickAutoAssignee(
  client: PoolClient,
  tenantId: string,
  teamId: string | null
): Promise<string | null> {
  const res = await client.query<{ id: string }>(
    `SELECT u.id
     FROM users u
     LEFT JOIN (
       SELECT assigned_agent_id AS user_id, COUNT(*) AS open_count
       FROM conversations
       WHERE tenant_id = $1 AND status <> 'closed' AND assigned_agent_id IS NOT NULL
       GROUP BY assigned_agent_id
     ) load ON load.user_id = u.id
     WHERE u.tenant_id = $1
       AND u.status = 'active'
       AND u.role = ANY($2::text[])
       AND ($3::uuid IS NULL OR EXISTS (
         SELECT 1 FROM team_members tm
         WHERE tm.team_id = $3::uuid AND tm.user_id = u.id AND tm.tenant_id = $1
       ))
     ORDER BY COALESCE(load.open_count, 0) ASC, u.last_auto_assigned_at ASC NULLS FIRST, u.id ASC
     LIMIT 1`,
    [tenantId, [...ASSIGNABLE_ROLES], teamId]
  );
  return res.rows[0]?.id ?? null;
}

/**
 * A bot flow handed the conversation to a human. Pauses the bot, records why, routes the case
 * (the node's agent, else the least-busy agent when auto-assign applies, else it waits as "pending")
 * and alerts the right agents. Team/agent ids come from flow JSON, so they are re-checked against
 * this tenant; a stale or foreign id is ignored (the case simply stays unassigned), never an error.
 */
export async function handOffConversation(params: HandoffParams): Promise<HandoffOutcome> {
  const { tenantId, conversationId } = params;

  let teamId: string | null = null;
  if (params.teamId && isUuid(params.teamId)) {
    const team = await queryOne<{ id: string }>("SELECT id FROM teams WHERE id = $1 AND tenant_id = $2", [
      params.teamId,
      tenantId,
    ]);
    if (team) teamId = team.id;
    else log.warn("Hand-off team not found in this workspace; ignoring it", { tenantId, conversationId });
  }

  let explicitAgentId: string | null = null;
  if (params.agentUserId && isUuid(params.agentUserId)) {
    try {
      await assertAssignableAgent(tenantId, params.agentUserId);
      explicitAgentId = params.agentUserId;
    } catch {
      log.warn("Hand-off agent is not an active agent of this workspace; ignoring it", { tenantId, conversationId });
    }
  }

  const handoffAt = new Date();
  const outcome = await withTransaction(async (client) => {
    const current = await client.query<{ assigned_agent_id: string | null; status: string }>(
      "SELECT assigned_agent_id, status FROM conversations WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
      [conversationId, tenantId]
    );
    const row = current.rows[0];
    if (!row || row.status === "closed") return null;

    // The node's agent always wins; a case that already has an agent keeps them.
    let agentId = explicitAgentId ?? row.assigned_agent_id;
    let autoAssigned = false;
    if (!agentId && (await shouldAutoAssign(client, tenantId, params.assignMode))) {
      // One hand-off at a time per workspace, so two simultaneous ones cannot both pick the same "least busy" agent.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [tenantId]);
      agentId = await pickAutoAssignee(client, tenantId, teamId);
      if (agentId) {
        autoAssigned = true;
        await client.query("UPDATE users SET last_auto_assigned_at = now() WHERE id = $1 AND tenant_id = $2", [
          agentId,
          tenantId,
        ]);
      } else {
        log.info("Auto-assign found no eligible agent; the case waits in Pending", { tenantId, conversationId });
      }
    }

    await client.query(
      `UPDATE conversations
       SET status = CASE WHEN $3::uuid IS NOT NULL THEN 'open' ELSE 'pending' END,
           bot_paused = true,
           assigned_agent_id = $3::uuid,
           assigned_team_id = COALESCE($4::uuid, assigned_team_id),
           handoff_at = $5,
           handoff_reason = $6,
           handoff_priority = $7,
           handoff_context = $8::jsonb,
           handoff_flow_name = $9
       WHERE id = $1 AND tenant_id = $2`,
      [
        conversationId,
        tenantId,
        agentId,
        teamId,
        handoffAt,
        params.reason ?? null,
        params.priority,
        capHandoffContext(params.context),
        params.flowName ?? null,
      ]
    );
    return { agentId, autoAssigned };
  });

  if (!outcome) return { applied: false, handoffAt: null, assignedAgentUserId: null, autoAssigned: false };

  // Audit and alerts are best effort: the hand-off itself is already committed and must not be undone by them.
  try {
    await AuditService.record({
      tenantId,
      action: "conversation.handed_off",
      resourceType: "conversation",
      resourceId: conversationId,
      details: {
        priority: params.priority,
        reason: params.reason ?? null,
        teamId,
        agentUserId: outcome.agentId,
        autoAssigned: outcome.autoAssigned,
      },
    });
    if (outcome.autoAssigned) {
      await AuditService.record({
        tenantId,
        action: "conversation.auto_assigned",
        resourceType: "conversation",
        resourceId: conversationId,
        details: { agentUserId: outcome.agentId, strategy: "least_busy", teamId },
      });
    }
    await emitConversationUpdate(tenantId, conversationId);
    const view = await getConversation(tenantId, conversationId);
    if (view) await notifyHandoff(tenantId, view);
  } catch (err) {
    log.warn("Hand-off follow-up (audit/alerts) failed", { error: (err as Error).message });
  }

  return { applied: true, handoffAt, assignedAgentUserId: outcome.agentId, autoAssigned: outcome.autoAssigned };
}

/**
 * Alerts the agents who should pick this case up: its agent, else its team's active members, else
 * every agent (clients ignore it for viewers). Sent per user, never with the conversation room, so
 * a webchat visitor's socket cannot receive it.
 */
async function notifyHandoff(tenantId: string, view: ConversationView): Promise<void> {
  const payload = {
    conversationId: view.id,
    contactName: view.contactName,
    reason: view.handoffReason,
    priority: view.handoffPriority ?? "normal",
    assignedAgentUserId: view.assignedAgentUserId,
    assignedTeamId: view.assignedTeamId,
    handoffAt: view.handoffAt,
  };

  let targetUserIds: string[] = [];
  if (view.assignedAgentUserId) {
    targetUserIds = [view.assignedAgentUserId];
  } else if (view.assignedTeamId) {
    const members = await query<{ user_id: string }>(
      `SELECT tm.user_id
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id AND u.tenant_id = tm.tenant_id
       WHERE tm.team_id = $1 AND tm.tenant_id = $2 AND u.status = 'active' AND u.role = ANY($3::text[])`,
      [view.assignedTeamId, tenantId, [...ASSIGNABLE_ROLES]]
    );
    targetUserIds = members.map((m) => m.user_id);
  }

  if (targetUserIds.length === 0) {
    await emitRealtimeEvent(tenantId, "conversation:handoff", payload);
    return;
  }
  await Promise.all(
    targetUserIds.map((userId) => emitRealtimeEvent(tenantId, "conversation:handoff", payload, { targetUserId: userId }))
  );
}

/**
 * Hand-off timeout: nobody took the case in time, so give it back to the bot. Acts only if the case is
 * still the same unclaimed, pending hand-off the timer was set for. Returns true when the bot was resumed.
 */
export async function resumeBotAfterHandoffTimeout(
  tenantId: string,
  conversationId: string,
  handoffAt: string
): Promise<boolean> {
  const released = await queryOne<{ id: string }>(
    `UPDATE conversations
     SET bot_paused = false, handoff_at = NULL, handoff_reason = NULL, handoff_priority = NULL,
         handoff_context = NULL, handoff_flow_name = NULL
     WHERE id = $1 AND tenant_id = $2 AND bot_paused = true AND status = 'pending'
       AND assigned_agent_id IS NULL AND handoff_at = $3::timestamptz
     RETURNING id`,
    [conversationId, tenantId, handoffAt]
  );
  if (!released) return false;

  await query(
    `UPDATE flow_runs SET status = 'completed', updated_at = now()
     WHERE conversation_id = $1 AND (status = 'handed_off' OR status = 'running')`,
    [conversationId]
  );
  await AuditService.record({
    tenantId,
    action: "conversation.handoff_timeout",
    resourceType: "conversation",
    resourceId: conversationId,
    details: { resumedBot: true },
  });
  emitRealtimeEvent(tenantId, "conversation:bot_resumed", { conversationId }, { conversationId }).catch((err) =>
    log.warn("Realtime bot-resumed event failed", { error: err.message })
  );
  await emitConversationUpdate(tenantId, conversationId);
  return true;
}

export interface VisitorHandoffState {
  /** bot: the flow is answering; waiting: handed off, nobody assigned yet; active: an agent has the case. */
  state: "bot" | "waiting" | "active";
  /** First name only: the visitor must not see an agent's email or full name. */
  agentFirstName: string | null;
}

/** What a webchat visitor is allowed to know about who is answering them. */
export async function getVisitorHandoffState(
  tenantId: string,
  conversationId: string
): Promise<VisitorHandoffState> {
  const row = await queryOne<{
    bot_paused: boolean;
    status: string;
    assigned_agent_id: string | null;
    agent_name: string | null;
  }>(
    `SELECT c.bot_paused, c.status, c.assigned_agent_id, u.name AS agent_name
     FROM conversations c
     LEFT JOIN users u ON u.id = c.assigned_agent_id AND u.tenant_id = c.tenant_id
     WHERE c.id = $1 AND c.tenant_id = $2`,
    [conversationId, tenantId]
  );
  if (!row || row.status === "closed" || !row.bot_paused) return { state: "bot", agentFirstName: null };
  if (!row.assigned_agent_id) return { state: "waiting", agentFirstName: null };
  return { state: "active", agentFirstName: row.agent_name?.trim().split(/\s+/)[0] || null };
}

/** True when the conversation exists in this workspace (cheap guard for lightweight endpoints). */
export async function conversationExists(tenantId: string, conversationId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>("SELECT id FROM conversations WHERE id = $1 AND tenant_id = $2", [
    conversationId,
    tenantId,
  ]);
  return row !== null;
}

export interface ConversationSummary {
  pending: number;
  unassigned: number;
  mine: number;
  /** Pending cases this user should pick up: assigned to them, or waiting with no agent in no team / one of their teams. */
  waitingForMe: number;
}

/** Counts for the sidebar badge: only non-closed cases. */
export async function getConversationSummary(tenantId: string, userId: string): Promise<ConversationSummary> {
  const row = await queryOne<{ pending: string; unassigned: string; mine: string; waiting_for_me: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending') AS pending,
       COUNT(*) FILTER (WHERE assigned_agent_id IS NULL) AS unassigned,
       COUNT(*) FILTER (WHERE $2::uuid IS NOT NULL AND assigned_agent_id = $2::uuid) AS mine,
       COUNT(*) FILTER (
         WHERE status = 'pending' AND $2::uuid IS NOT NULL AND (
           assigned_agent_id = $2::uuid
           OR (assigned_agent_id IS NULL AND (
                assigned_team_id IS NULL
                OR assigned_team_id IN (
                  SELECT tm.team_id FROM team_members tm WHERE tm.user_id = $2::uuid AND tm.tenant_id = $1
                )))
         )
       ) AS waiting_for_me
     FROM conversations
     WHERE tenant_id = $1 AND status <> 'closed'`,
    [tenantId, isUuid(userId) ? userId : null]
  );
  return {
    pending: Number(row?.pending ?? 0),
    unassigned: Number(row?.unassigned ?? 0),
    mine: Number(row?.mine ?? 0),
    waitingForMe: Number(row?.waiting_for_me ?? 0),
  };
}

/** A bot flow handed the conversation to a human: surface it as "pending" until someone takes it. */
export async function markConversationNeedsHuman(
  tenantId: string,
  conversationId: string
): Promise<void> {
  const changed = await queryOne<{ id: string }>(
    `UPDATE conversations SET status = 'pending'
     WHERE id = $1 AND tenant_id = $2 AND status = 'open' RETURNING id`,
    [conversationId, tenantId]
  );
  if (changed) await emitConversationUpdate(tenantId, conversationId);
}

/**
 * A customer wrote to a closed case: reopen that same case instead of starting a new one.
 * The previous agent and team stay on it, unless that agent is no longer active. Resolution
 * timestamps are cleared so the case counts as unresolved again until it is closed anew.
 * Returns true when a closed case was reopened.
 */
export async function reopenOnCustomerMessage(
  tenantId: string,
  conversationId: string
): Promise<boolean> {
  const reopened = await queryOne<{ id: string }>(
    `UPDATE conversations c
     SET status = 'open',
         resolved_at = NULL,
         resolution_duration_seconds = NULL,
         assigned_agent_id = CASE
           WHEN EXISTS (
             SELECT 1 FROM users u
             WHERE u.id = c.assigned_agent_id AND u.tenant_id = c.tenant_id AND u.status = 'active'
           ) THEN c.assigned_agent_id
           ELSE NULL END
     WHERE c.id = $1 AND c.tenant_id = $2 AND c.status = 'closed'
     RETURNING c.id`,
    [conversationId, tenantId]
  );
  if (!reopened) return false;

  await AuditService.record({
    tenantId,
    action: "conversation.reopened_by_customer",
    resourceType: "conversation",
    resourceId: conversationId,
    details: { from: "closed", to: "open" },
  });
  emitRealtimeEvent(
    tenantId,
    "conversation:status",
    { conversationId, status: "open" },
    { conversationId }
  ).catch((err) => log.warn("Realtime status event failed", { error: err.message }));
  return true;
}

/**
 * A human agent replied: take an unassigned case for them and move "pending" to "open".
 * Ignores ids that are not an active agent of the tenant (e.g. API keys) and closed cases.
 */
export async function claimOnHumanReply(
  tenantId: string,
  conversationId: string,
  userId: string
): Promise<void> {
  const changed = await queryOne<{ id: string }>(
    `UPDATE conversations
     SET assigned_agent_id = COALESCE(assigned_agent_id, $1),
         status = CASE WHEN status = 'pending' THEN 'open' ELSE status END
     WHERE id = $2 AND tenant_id = $3 AND status <> 'closed'
       AND (assigned_agent_id IS NULL OR status = 'pending')
       AND EXISTS (
         SELECT 1 FROM users
         WHERE id = $1 AND tenant_id = $3 AND status = 'active' AND role = ANY($4::text[])
       )
     RETURNING id`,
    [userId, conversationId, tenantId, [...ASSIGNABLE_ROLES]]
  );
  if (changed) await emitConversationUpdate(tenantId, conversationId);
}
