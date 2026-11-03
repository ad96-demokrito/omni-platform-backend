import { Router, Response } from "express";
import { AuthedRequest, requireAuth, requireRole } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import {
  createCampaign,
  listCampaigns,
  getCampaign,
  deleteCampaign,
  getCampaignRecipients,
  getCampaignAnalytics,
} from "./campaigns.service";
import { sendBroadcastNow, startDrip } from "./campaign-sender";
import { DripStep, normalizeDripSteps } from "./campaigns.types";
import {
  getCampaignExportData,
  buildCampaignExportWorkbook,
  campaignExportFileName,
} from "./campaign-export";
import { AuditService } from "../audit/audit.service";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const campaignsRouter = Router();
campaignsRouter.use(requireAuth);

campaignsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    res.json(await listCampaigns(req.auth!.tenantId));
  })
);

campaignsRouter.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const campaign = await getCampaign(req.auth!.tenantId, req.params.id);
    if (!campaign) return res.sendStatus(404);
    res.json(campaign);
  })
);

campaignsRouter.get(
  "/:id/analytics",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const analytics = await getCampaignAnalytics(req.auth!.tenantId, req.params.id);
    if (!analytics) return res.sendStatus(404);
    res.json(analytics);
  })
);

campaignsRouter.get(
  "/:id/recipients",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { status, search, limit, offset } = req.query;
    const recipients = await getCampaignRecipients(req.auth!.tenantId, req.params.id, {
      status: typeof status === "string" ? status : undefined,
      search: typeof search === "string" ? search : undefined,
      limit: limit ? parseInt(limit as string, 10) : 50,
      offset: offset ? parseInt(offset as string, 10) : 0,
    });
    res.json(recipients);
  })
);

/** Excel export: one row per recipient with delivery status and the flow questions they answered. */
campaignsRouter.get(
  "/:id/export",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { tenantId, userId, email } = req.auth!;
    const data = await getCampaignExportData(tenantId, req.params.id);
    if (!data) return res.sendStatus(404);

    const file = buildCampaignExportWorkbook(data);

    await AuditService.record({
      tenantId,
      userId,
      userEmail: email,
      action: "campaign.export",
      resourceType: "campaign",
      resourceId: req.params.id,
      details: { recipients: data.rows.length, questions: data.columns.length },
      ipAddress: req.ip,
    });

    res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
    res.setHeader("Content-Disposition", `attachment; filename="${campaignExportFileName(data.campaignName)}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(file);
  })
);

campaignsRouter.delete(
  "/:id",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const deleted = await deleteCampaign(req.auth!.tenantId, req.params.id);
    if (!deleted) return res.sendStatus(404);
    res.json({ success: true });
  })
);

/**
 * Body shape:
 *   broadcast: { channelId, name, type: "broadcast", tags?: string[], contactIds?: string[], definition: { text, tags? } }
 *   flow:      { channelId, name, type: "flow", tags?: string[], contactIds?: string[], definition: { flowId, tags? } }
 *   drip:      { channelId, name, type: "drip", tags?: string[], contactIds?: string[], definition: { steps: [{ delayHours, text }, ...] } }
 */
campaignsRouter.post(
  "/",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const { channelId, name, type, contactIds, tags, definition } = req.body || {};

    if (!channelId || !name || !type) {
      return res.status(400).json({ error: "channelId, name, and type are required" });
    }

    if (type !== "broadcast" && type !== "drip" && type !== "flow") {
      return res.status(400).json({ error: "type must be 'broadcast', 'flow', or 'drip'" });
    }

    if (type === "flow" && !definition?.flowId && !req.body.flowId) {
      return res.status(400).json({ error: "flow campaign requires a valid flowId in definition" });
    }

    if (
      type === "broadcast" &&
      !definition?.text &&
      !definition?.flowId &&
      !definition?.templateName &&
      !req.body.flowId &&
      !req.body.message &&
      !req.body.templateName
    ) {
      return res.status(400).json({ error: "broadcast definition requires a text, templateName, or flowId field" });
    }

    let dripSteps: DripStep[] | undefined;
    if (type === "drip") {
      const normalized = normalizeDripSteps(definition?.steps);
      if ("error" in normalized) return res.status(400).json({ error: normalized.error });
      dripSteps = normalized.steps;
    }

    const mergedDefinition = {
      ...definition,
      ...(dripSteps ? { steps: dripSteps } : {}),
      ...(type === "flow" && req.body.flowId ? { flowId: req.body.flowId } : {}),
      ...(type === "broadcast" && req.body.message ? { text: req.body.message } : {}),
      ...(type === "broadcast" && req.body.templateName ? { templateName: req.body.templateName } : {}),
      ...(tags ? { tags } : {}),
    };

    try {
      const campaign = await createCampaign({
        tenantId: req.auth!.tenantId,
        channelId,
        name,
        type,
        definition: mergedDefinition,
        contactIds,
        tags,
      });
      res.status(201).json(campaign);
    } catch (err: any) {
      if (err?.code === "23503") {
        return res.status(400).json({
          error: "channelId or one of contactIds does not refer to an existing record for this tenant",
        });
      }
      res.status(400).json({ error: err?.message || "Failed to create campaign" });
    }
  })
);

/**
 * Trigger send for a broadcast or flow campaign, or start a draft drip sequence.
 * A drip answers { sent: 0, failed: 0, started: true, scheduled } because its steps go out later.
 */
campaignsRouter.post(
  "/:id/send",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    try {
      const tenantId = req.auth!.tenantId;
      const campaign = await getCampaign(tenantId, req.params.id);
      if (!campaign) return res.status(404).json({ error: "Campaign not found" });

      if (campaign.type === "drip") {
        const started = await startDrip(tenantId, campaign);
        if (!started) return res.status(409).json({ error: "This drip campaign has already been started" });
        return res.json({ sent: 0, failed: 0, started: true, scheduled: started.scheduled });
      }

      const result = await sendBroadcastNow(tenantId, req.params.id);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Failed to send campaign" });
    }
  })
);
