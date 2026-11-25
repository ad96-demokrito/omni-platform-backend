import { Router, Response } from "express";
import { requireAuth, requireRole, AuthedRequest } from "../../middleware/auth";
import { requireFeature } from "../billing/plan-limits.service";
import { AuditService } from "./audit.service";
import { asyncHandler } from "../../middleware/async-handler";

export const auditRouter = Router();

auditRouter.use(requireAuth);
auditRouter.use(requireFeature("audit_compliance"));

/**
 * GET /api/audit-logs
 * List audit logs with pagination and filters (Admin/Owner only)
 */
auditRouter.get(
  "/",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const { action, resourceType, limit, offset } = req.query;

    const result = await AuditService.list(tenantId, {
      action: action ? String(action) : undefined,
      resourceType: resourceType ? String(resourceType) : undefined,
      limit: limit ? parseInt(String(limit), 10) : 50,
      offset: offset ? parseInt(String(offset), 10) : 0,
    });

    res.json(result);
  })
);

/**
 * GET /api/audit-logs/stats
 * Get high-level audit and security statistics
 */
auditRouter.get(
  "/stats",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const stats = await AuditService.getStats(tenantId);
    res.json(stats);
  })
);
