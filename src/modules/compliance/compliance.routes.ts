import { Router, Response } from "express";
import { requireAuth, requireRole, AuthedRequest } from "../../middleware/auth";
import { requireFeature } from "../billing/plan-limits.service";
import { ComplianceService } from "./compliance.service";
import { asyncHandler } from "../../middleware/async-handler";

export const complianceRouter = Router();

complianceRouter.use(requireAuth);
complianceRouter.use(requireFeature("audit_compliance"));

/**
 * POST /api/compliance/export
 * GDPR Art. 15 Subject Access Data Export (Admin/Owner only)
 */
complianceRouter.post(
  "/export",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const actorId = req.auth!.userId;
    const { contactId } = req.body;

    if (!contactId || typeof contactId !== "string") {
      return res.status(400).json({ error: "Contact ID is required for GDPR export" });
    }

    const bundle = await ComplianceService.exportContactData({
      tenantId,
      contactId,
      actorId,
      ipAddress: req.ip,
    });

    res.json(bundle);
  })
);

/**
 * POST /api/compliance/purge
 * GDPR Art. 17 Right to Erasure / Right to be Forgotten (Owner only)
 */
complianceRouter.post(
  "/purge",
  requireRole("owner"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const actorId = req.auth!.userId;
    const { contactId } = req.body;

    if (!contactId || typeof contactId !== "string") {
      return res.status(400).json({ error: "Contact ID is required for GDPR erasure" });
    }

    const result = await ComplianceService.purgeContactData({
      tenantId,
      contactId,
      actorId,
      ipAddress: req.ip,
    });

    res.json(result);
  })
);
