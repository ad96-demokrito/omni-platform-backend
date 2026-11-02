import { query, queryOne } from "../../db/pool";
import { FlowDefinition } from "./flows.types";

export interface Flow {
  id: string;
  tenant_id: string;
  name: string;
  definition: FlowDefinition;
  status: "draft" | "published";
  version: number;
  deleted_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowRun {
  id: string;
  conversation_id: string;
  flow_id: string;
  current_node_id: string | null;
  variables: Record<string, any>;
  status: "running" | "completed" | "handed_off" | "failed";
  /** Set when the run was started by a campaign; answers are then recorded per recipient. */
  campaign_id: string | null;
  campaign_recipient_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function createFlow(params: {
  tenantId: string;
  name: string;
  definition: FlowDefinition;
}): Promise<Flow> {
  const row = await queryOne<Flow>(
    `INSERT INTO flows (tenant_id, name, definition) VALUES ($1, $2, $3) RETURNING *`,
    [params.tenantId, params.name, params.definition]
  );
  return row!;
}

export async function updateFlowDefinition(
  tenantId: string,
  flowId: string,
  definition: FlowDefinition
): Promise<Flow | null> {
  return queryOne<Flow>(
    `UPDATE flows SET definition = $1, updated_at = now()
     WHERE id = $2 AND tenant_id = $3 AND deleted_at IS NULL RETURNING *`,
    [definition, flowId, tenantId]
  );
}

export async function deleteFlow(tenantId: string, flowId: string): Promise<boolean> {
  // Soft delete the flow record
  const res = await query(
    `UPDATE flows
     SET deleted_at = now(), updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [flowId, tenantId]
  );
  if (res.length === 0) return false;

  // Detach / unlink any channels where this flow is configured as default
  await query(
    `UPDATE channels
     SET default_flow_id = NULL
     WHERE tenant_id = $1 AND default_flow_id = $2`,
    [tenantId, flowId]
  );

  // Terminate any in-flight running flow executions for this flow
  await query(
    `UPDATE flow_runs
     SET status = 'completed', updated_at = now()
     WHERE flow_id = $1 AND status = 'running'`,
    [flowId]
  );

  return true;
}

export async function publishFlow(tenantId: string, flowId: string): Promise<Flow | null> {
  return queryOne<Flow>(
    `UPDATE flows SET status = 'published', version = version + 1, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING *`,
    [flowId, tenantId]
  );
}

export async function getFlow(tenantId: string, flowId: string): Promise<Flow | null> {
  return queryOne<Flow>(
    "SELECT * FROM flows WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL",
    [flowId, tenantId]
  );
}

export async function listFlows(tenantId: string): Promise<Flow[]> {
  return query<Flow>(
    "SELECT * FROM flows WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC",
    [tenantId]
  );
}

export async function getActiveFlowRun(conversationId: string): Promise<FlowRun | null> {
  return queryOne<FlowRun>(
    `SELECT * FROM flow_runs WHERE conversation_id = $1 AND status = 'running'
     ORDER BY created_at DESC LIMIT 1`,
    [conversationId]
  );
}

export async function getLatestFlowRun(conversationId: string): Promise<FlowRun | null> {
  return queryOne<FlowRun>(
    `SELECT * FROM flow_runs WHERE conversation_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [conversationId]
  );
}

export async function createFlowRun(params: {
  conversationId: string;
  flowId: string;
  campaignId?: string;
  campaignRecipientId?: string;
}): Promise<FlowRun> {
  const row = await queryOne<FlowRun>(
    `INSERT INTO flow_runs (conversation_id, flow_id, campaign_id, campaign_recipient_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [params.conversationId, params.flowId, params.campaignId ?? null, params.campaignRecipientId ?? null]
  );
  return row!;
}

/** Attributes an already-running run to a campaign recipient, unless it already has one. */
export async function attachFlowRunToCampaign(
  flowRunId: string,
  campaignId: string,
  campaignRecipientId: string
): Promise<void> {
  await query(
    `UPDATE flow_runs SET campaign_id = $2, campaign_recipient_id = $3, updated_at = now()
     WHERE id = $1 AND campaign_id IS NULL`,
    [flowRunId, campaignId, campaignRecipientId]
  );
}

/** Ends a run without touching its state, so it no longer counts as the conversation's active run. */
export async function endFlowRun(flowRunId: string, status: "completed" | "failed"): Promise<void> {
  await query(
    `UPDATE flow_runs SET status = $2, updated_at = now() WHERE id = $1 AND status = 'running'`,
    [flowRunId, status]
  );
}

export async function updateFlowRun(
  flowRunId: string,
  updates: { currentNodeId: string | null; variables: Record<string, any>; status: FlowRun["status"] }
): Promise<void> {
  await query(
    `UPDATE flow_runs SET current_node_id = $1, variables = $2, status = $3, updated_at = now()
     WHERE id = $4`,
    [updates.currentNodeId, updates.variables, updates.status, flowRunId]
  );
}
