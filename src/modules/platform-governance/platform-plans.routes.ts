import { Router, Response } from "express";
import { asyncHandler } from "../../middleware/async-handler";
import {
  requirePlatformAuth,
  requirePlatformRole,
  logPlatformAudit,
  PlatformAuthedRequest,
} from "../../middleware/platform-auth";
import {
  listPlatformPlans,
  getPlatformPlanById,
  createPlatformPlan,
  updatePlatformPlan,
  deleteOrDeactivatePlatformPlan,
} from "./platform-plans.service";
import { enforcementMode, listWouldBlockCounts } from "../billing/plan-limits.service";

export const platformPlansRouter = Router();

platformPlansRouter.use(requirePlatformAuth);

/**
 * GET /api/platform/plans
 * List all platform plans (including inactive/custom for platform staff)
 */
platformPlansRouter.get(
  "/",
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const includeInactive = req.query.includeInactive !== "false";
    const plans = await listPlatformPlans({ includeInactive });
    res.json(plans);
  })
);

/**
 * GET /api/platform/plans/enforcement-report
 * What PLAN_ENFORCEMENT would block this month, per workspace and reason. Read this in "warn" mode before
 * switching to "enforce" (Super Admin only).
 */
platformPlansRouter.get(
  "/enforcement-report",
  requirePlatformRole("super_admin"),
  asyncHandler(async (_req: PlatformAuthedRequest, res: Response) => {
    res.json({ mode: enforcementMode(), wouldBlock: await listWouldBlockCounts() });
  })
);

/**
 * GET /api/platform/plans/:id
 * Get single plan details
 */
platformPlansRouter.get(
  "/:id",
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const plan = await getPlatformPlanById(req.params.id);
    if (!plan) {
      return res.status(404).json({ error: "Plan not found" });
    }
    res.json(plan);
  })
);

/**
 * POST /api/platform/plans
 * Create a new platform plan tier (Super Admin only)
 */
platformPlansRouter.post(
  "/",
  requirePlatformRole("super_admin"),
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const {
      id,
      name,
      description,
      prices,
      priceMonthly,
      priceYearly,
      currency,
      maxChannels,
      maxContacts,
      maxMonthlyMessages,
      maxMonthlyAiQueries,
      features,
      featureFlags,
      badgeText,
      isActive,
      isPublic,
      isCustom,
    } = req.body;

    if (!id || !name || (priceMonthly === undefined && !Array.isArray(prices))) {
      return res.status(400).json({ error: "id, name, and either prices or priceMonthly are required" });
    }

    const newPlan = await createPlatformPlan({
      id,
      name,
      description,
      prices: Array.isArray(prices) ? prices : undefined,
      priceMonthly: Number(priceMonthly ?? 0),
      priceYearly: priceYearly !== undefined ? Number(priceYearly) : undefined,
      currency,
      maxChannels: Number(maxChannels || 1),
      maxContacts: Number(maxContacts || 500),
      maxMonthlyMessages: Number(maxMonthlyMessages || 2000),
      maxMonthlyAiQueries: Number(maxMonthlyAiQueries || 100),
      features,
      featureFlags,
      badgeText,
      isActive,
      isPublic,
      isCustom,
    });

    await logPlatformAudit({
      platformUser: req.platformUser!,
      action: "plan.create",
      targetType: "platform_plan",
      targetId: newPlan.id,
      details: { planName: newPlan.name, priceMonthly: newPlan.priceMonthly },
      req,
    });

    res.status(201).json(newPlan);
  })
);

/**
 * PUT /api/platform/plans/:id
 * Update an existing platform plan tier (Super Admin only)
 */
platformPlansRouter.put(
  "/:id",
  requirePlatformRole("super_admin"),
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const updatedPlan = await updatePlatformPlan(req.params.id, req.body);

    await logPlatformAudit({
      platformUser: req.platformUser!,
      action: "plan.update",
      targetType: "platform_plan",
      targetId: updatedPlan.id,
      details: { planName: updatedPlan.name, priceMonthly: updatedPlan.priceMonthly, changes: Object.keys(req.body) },
      req,
    });

    res.json(updatedPlan);
  })
);

/**
 * DELETE /api/platform/plans/:id
 * Deactivate or remove a plan (Super Admin only)
 */
platformPlansRouter.delete(
  "/:id",
  requirePlatformRole("super_admin"),
  asyncHandler(async (req: PlatformAuthedRequest, res: Response) => {
    const result = await deleteOrDeactivatePlatformPlan(req.params.id);

    await logPlatformAudit({
      platformUser: req.platformUser!,
      action: result.deleted ? "plan.delete" : "plan.deactivate",
      targetType: "platform_plan",
      targetId: req.params.id,
      details: { message: result.message },
      req,
    });

    res.json(result);
  })
);
