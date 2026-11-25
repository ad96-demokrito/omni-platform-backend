import { Router, Response } from "express";
import { requireAuth, requireRole, AuthedRequest } from "../../middleware/auth";
import { TeamService } from "./team.service";
import { asyncHandler } from "../../middleware/async-handler";
import { assertFeature } from "../billing/plan-limits.service";

export const teamRouter = Router();

teamRouter.use(requireAuth);

/**
 * GET /api/team
 * List all members in the current workspace
 */
teamRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const members = await TeamService.listMembers(tenantId);
    res.json(members);
  })
);

/**
 * POST /api/team/invite
 * Invite a new team member (Owner/Admin only)
 */
teamRouter.post(
  "/invite",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const actorId = req.auth!.userId;
    const { email, name, role, password } = req.body;

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email address is required" });
    }

    const assignedRole = role || "agent";
    if (!["admin", "agent", "viewer"].includes(assignedRole)) {
      return res.status(400).json({ error: "Role must be one of: admin, agent, viewer" });
    }
    // Every plan can invite agents; choosing another role is a plan feature.
    if (assignedRole !== "agent") await assertFeature(tenantId, "teams_roles");

    const created = await TeamService.inviteMember({
      tenantId,
      actorId,
      email,
      name: name ? String(name).trim() : undefined,
      role: assignedRole,
      password: password ? String(password) : undefined,
      ipAddress: req.ip,
    });

    res.status(201).json(created);
  })
);

/**
 * PATCH /api/team/:id/role
 * Update team member role (Owner/Admin only)
 */
teamRouter.patch(
  "/:id/role",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const actorId = req.auth!.userId;
    const targetUserId = req.params.id;
    const { role } = req.body;

    if (!["owner", "admin", "agent", "viewer"].includes(role)) {
      return res.status(400).json({ error: "Invalid role specified" });
    }

    // Only owners can assign the 'owner' role to someone else
    if (role === "owner" && req.auth!.role !== "owner") {
      return res.status(403).json({ error: "Only workspace owners can promote members to owner" });
    }
    // Moving a member back to "agent" stays allowed on every plan; any other role is a plan feature.
    if (role !== "agent") await assertFeature(tenantId, "teams_roles");

    const updated = await TeamService.updateRole({
      tenantId,
      actorId,
      targetUserId,
      newRole: role,
      ipAddress: req.ip,
    });

    res.json(updated);
  })
);

/**
 * PATCH /api/team/:id/status
 * Toggle user active/deactivated status (Owner/Admin only)
 */
teamRouter.patch(
  "/:id/status",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const actorId = req.auth!.userId;
    const targetUserId = req.params.id;
    const { status } = req.body;

    if (!["active", "deactivated"].includes(status)) {
      return res.status(400).json({ error: "Status must be 'active' or 'deactivated'" });
    }

    const updated = await TeamService.updateStatus({
      tenantId,
      actorId,
      targetUserId,
      status,
      ipAddress: req.ip,
    });

    res.json(updated);
  })
);

/**
 * DELETE /api/team/:id
 * Remove member from workspace (Owner/Admin only)
 */
teamRouter.delete(
  "/:id",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const actorId = req.auth!.userId;
    const targetUserId = req.params.id;

    const success = await TeamService.removeMember({
      tenantId,
      actorId,
      targetUserId,
      ipAddress: req.ip,
    });

    if (!success) {
      return res.status(404).json({ error: "Team member not found" });
    }

    res.json({ message: "Team member removed from workspace", id: targetUserId });
  })
);
