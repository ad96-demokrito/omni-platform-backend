import { Router, Response } from "express";
import { requireAuth, requireRole, AuthedRequest } from "../../middleware/auth";
import { requireFeature } from "../billing/plan-limits.service";
import { ApiKeysService } from "./api-keys.service";
import { asyncHandler } from "../../middleware/async-handler";

export const apiKeysRouter = Router();

apiKeysRouter.use(requireAuth);
apiKeysRouter.use(requireFeature("api_keys"));

/**
 * GET /api/api-keys
 * List developer API keys for the current tenant
 */
apiKeysRouter.get(
  "/",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const keys = await ApiKeysService.listKeys(tenantId);
    res.json(keys);
  })
);

/**
 * POST /api/api-keys
 * Generate a new API key
 */
apiKeysRouter.post(
  "/",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const userId = req.auth!.userId;
    const { name, scopes, expiresInDays } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Key name is required" });
    }

    const created = await ApiKeysService.createKey({
      tenantId,
      userId,
      name: name.trim(),
      scopes: Array.isArray(scopes) ? scopes : undefined,
      expiresInDays: expiresInDays ? parseInt(expiresInDays, 10) : undefined,
      ipAddress: req.ip,
    });

    res.status(201).json(created);
  })
);

/**
 * DELETE /api/api-keys/:id
 * Revoke an API key
 */
apiKeysRouter.delete(
  "/:id",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const userId = req.auth!.userId;
    const apiKeyId = req.params.id;

    const success = await ApiKeysService.revokeKey({
      tenantId,
      apiKeyId,
      userId,
      ipAddress: req.ip,
    });

    if (!success) {
      return res.status(404).json({ error: "API key not found" });
    }

    res.json({ message: "API key revoked successfully", id: apiKeyId });
  })
);
