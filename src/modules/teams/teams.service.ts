import { query, queryOne, withTransaction } from "../../db/pool";
import { AuditService } from "../audit/audit.service";
import { httpError, isUuid } from "../../utils/http-error";

/** Roles that can work conversations, so the only ones that can belong to a support team. */
export const ASSIGNABLE_ROLES = ["owner", "admin", "agent"] as const;

const MAX_TEAM_NAME_LENGTH = 60;
const MAX_TEAM_DESCRIPTION_LENGTH = 300;
const MAX_TEAM_MEMBERS = 500;

export interface Team {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  created_at: string;
  memberIds: string[];
}

interface Actor {
  userId: string;
  email?: string;
  ipAddress?: string;
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw httpError(400, "Team name is required");
  if (name.length > MAX_TEAM_NAME_LENGTH) {
    throw httpError(400, `Team name must be at most ${MAX_TEAM_NAME_LENGTH} characters`);
  }
  return name;
}

function cleanDescription(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > MAX_TEAM_DESCRIPTION_LENGTH) {
    throw httpError(400, `Description must be at most ${MAX_TEAM_DESCRIPTION_LENGTH} characters`);
  }
  return value.trim() || null;
}

export interface TeamSettings {
  /** When on, a flow hand-off is assigned to the least busy agent instead of waiting in Pending. */
  autoAssignEnabled: boolean;
}

export async function getTeamSettings(tenantId: string): Promise<TeamSettings> {
  const row = await queryOne<{ auto_assign_enabled: boolean }>(
    "SELECT auto_assign_enabled FROM tenants WHERE id = $1",
    [tenantId]
  );
  return { autoAssignEnabled: row?.auto_assign_enabled === true };
}

export async function updateTeamSettings(
  tenantId: string,
  actor: Actor,
  input: { autoAssignEnabled?: unknown }
): Promise<TeamSettings> {
  if (typeof input.autoAssignEnabled !== "boolean") {
    throw httpError(400, "autoAssignEnabled must be true or false");
  }
  const updated = await queryOne<{ auto_assign_enabled: boolean }>(
    "UPDATE tenants SET auto_assign_enabled = $1 WHERE id = $2 RETURNING auto_assign_enabled",
    [input.autoAssignEnabled, tenantId]
  );
  if (!updated) throw httpError(404, "Workspace not found");

  await AuditService.record({
    tenantId,
    userId: actor.userId,
    userEmail: actor.email,
    action: "tenant.auto_assign_changed",
    resourceType: "tenant",
    resourceId: tenantId,
    details: { autoAssignEnabled: input.autoAssignEnabled },
    ipAddress: actor.ipAddress,
  });
  return { autoAssignEnabled: updated.auto_assign_enabled };
}

export async function listTeams(tenantId: string): Promise<Team[]> {
  return query<Team>(
    `SELECT t.id, t.tenant_id, t.name, t.description, t.created_at,
            COALESCE(array_agg(tm.user_id) FILTER (WHERE tm.user_id IS NOT NULL), '{}') AS "memberIds"
     FROM teams t
     LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.tenant_id = t.tenant_id
     WHERE t.tenant_id = $1
     GROUP BY t.id
     ORDER BY t.name ASC`,
    [tenantId]
  );
}

export async function getTeam(tenantId: string, teamId: string): Promise<Team | null> {
  const teams = await query<Team>(
    `SELECT t.id, t.tenant_id, t.name, t.description, t.created_at,
            COALESCE(array_agg(tm.user_id) FILTER (WHERE tm.user_id IS NOT NULL), '{}') AS "memberIds"
     FROM teams t
     LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.tenant_id = t.tenant_id
     WHERE t.id = $1 AND t.tenant_id = $2
     GROUP BY t.id`,
    [teamId, tenantId]
  );
  return teams[0] ?? null;
}

export async function createTeam(
  tenantId: string,
  actor: Actor,
  input: { name: unknown; description?: unknown }
): Promise<Team> {
  const name = cleanName(input.name);
  const description = cleanDescription(input.description);

  const created = await queryOne<{ id: string }>(
    `INSERT INTO teams (tenant_id, name, description) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, name) DO NOTHING
     RETURNING id`,
    [tenantId, name, description]
  );
  if (!created) throw httpError(409, "A team with this name already exists");

  await AuditService.record({
    tenantId,
    userId: actor.userId,
    userEmail: actor.email,
    action: "team.created",
    resourceType: "team",
    resourceId: created.id,
    details: { name },
    ipAddress: actor.ipAddress,
  });
  return (await getTeam(tenantId, created.id))!;
}

export async function updateTeam(
  tenantId: string,
  actor: Actor,
  teamId: string,
  input: { name: unknown; description?: unknown }
): Promise<Team> {
  const name = cleanName(input.name);
  const description = cleanDescription(input.description);

  const duplicate = await queryOne<{ id: string }>(
    "SELECT id FROM teams WHERE tenant_id = $1 AND name = $2 AND id <> $3",
    [tenantId, name, teamId]
  );
  if (duplicate) throw httpError(409, "A team with this name already exists");

  const updated = await queryOne<{ id: string }>(
    `UPDATE teams SET name = $1, description = $2
     WHERE id = $3 AND tenant_id = $4 RETURNING id`,
    [name, description, teamId, tenantId]
  );
  if (!updated) throw httpError(404, "Team not found");

  await AuditService.record({
    tenantId,
    userId: actor.userId,
    userEmail: actor.email,
    action: "team.updated",
    resourceType: "team",
    resourceId: teamId,
    details: { name },
    ipAddress: actor.ipAddress,
  });
  return (await getTeam(tenantId, teamId))!;
}

export async function deleteTeam(tenantId: string, actor: Actor, teamId: string): Promise<void> {
  const deleted = await queryOne<{ id: string }>(
    "DELETE FROM teams WHERE id = $1 AND tenant_id = $2 RETURNING id",
    [teamId, tenantId]
  );
  if (!deleted) throw httpError(404, "Team not found");

  await AuditService.record({
    tenantId,
    userId: actor.userId,
    userEmail: actor.email,
    action: "team.deleted",
    resourceType: "team",
    resourceId: teamId,
    ipAddress: actor.ipAddress,
  });
}

/** Replaces the team's members. Every id must be an active user of this tenant who can work chats. */
export async function setTeamMembers(
  tenantId: string,
  actor: Actor,
  teamId: string,
  userIds: unknown
): Promise<Team> {
  if (!Array.isArray(userIds) || userIds.length > MAX_TEAM_MEMBERS || !userIds.every(isUuid)) {
    throw httpError(400, "userIds must be an array of user ids");
  }
  const uniqueIds = [...new Set(userIds as string[])];

  const team = await getTeam(tenantId, teamId);
  if (!team) throw httpError(404, "Team not found");

  if (uniqueIds.length > 0) {
    const valid = await query<{ id: string }>(
      `SELECT id FROM users
       WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND status = 'active' AND role = ANY($3::text[])`,
      [tenantId, uniqueIds, [...ASSIGNABLE_ROLES]]
    );
    if (valid.length !== uniqueIds.length) {
      throw httpError(400, "Every member must be an active owner, admin or agent of this workspace");
    }
  }

  await withTransaction(async (client) => {
    await client.query("DELETE FROM team_members WHERE team_id = $1 AND tenant_id = $2", [
      teamId,
      tenantId,
    ]);
    for (const userId of uniqueIds) {
      await client.query(
        "INSERT INTO team_members (team_id, user_id, tenant_id) VALUES ($1, $2, $3)",
        [teamId, userId, tenantId]
      );
    }
  });

  await AuditService.record({
    tenantId,
    userId: actor.userId,
    userEmail: actor.email,
    action: "team.members_changed",
    resourceType: "team",
    resourceId: teamId,
    details: { memberCount: uniqueIds.length },
    ipAddress: actor.ipAddress,
  });
  return (await getTeam(tenantId, teamId))!;
}
