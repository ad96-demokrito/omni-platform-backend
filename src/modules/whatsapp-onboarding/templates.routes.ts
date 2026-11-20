import { Router } from "express";
import { AuthedRequest, requireAuth, requireRole } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { getChannelWithCredentials } from "../channels/channels.service";
import { listTemplates, createTemplate } from "./templates.service";
import { collectMediaStorageKeys, validateCarouselTemplate } from "./carousel-template";
import { isSafeMediaKey, tenantOwnsKey } from "../media/media.service";
import { Logger } from "../../utils/logger";

const log = new Logger("templates");

export const templatesRouter = Router();
templatesRouter.use(requireAuth);

async function loadWhatsAppChannelOrRespond(
  req: AuthedRequest,
  res: import("express").Response
): Promise<{ wabaId: string; accessToken: string; apiBaseUrl: string } | null> {
  const channel = await getChannelWithCredentials(req.auth!.tenantId, req.params.channelId);
  if (!channel) {
    res.status(404).json({ error: "Channel not found" });
    return null;
  }
  let credentials = channel.credentials;
  if (typeof credentials === "string") {
    try {
      credentials = JSON.parse(credentials);
    } catch {
      credentials = {};
    }
  }
  if (channel.type !== "whatsapp") {
    res.status(400).json({ error: "Templates are only available for WhatsApp channels" });
    return null;
  }
  if (!credentials?.wabaId) {
    res.status(400).json({ error: "WhatsApp channel is missing WABA ID. Please reconnect via Embedded Signup." });
    return null;
  }
  if (!credentials?.accessToken) {
    res.status(400).json({ error: "WhatsApp channel is missing access token. Please reconnect via Embedded Signup." });
    return null;
  }
  return {
    wabaId: credentials.wabaId,
    accessToken: credentials.accessToken,
    apiBaseUrl: credentials.apiBaseUrl || "https://graph.facebook.com/v21.0",
  };
}

templatesRouter.get(
  "/:channelId/templates",
  asyncHandler(async (req: AuthedRequest, res) => {
    const creds = await loadWhatsAppChannelOrRespond(req, res);
    if (!creds) return;
    try {
      const templates = await listTemplates(creds.wabaId, creds.accessToken, creds.apiBaseUrl);
      res.json(templates);
    } catch (err: any) {
      log.error(`Failed to list templates for WABA ${creds.wabaId}:`, err);
      res.status(400).json({ error: err instanceof Error ? err.message : "Failed to list templates from Meta" });
    }
  })
);

templatesRouter.post(
  "/:channelId/templates",
  requireRole("owner", "admin"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const creds = await loadWhatsAppChannelOrRespond(req, res);
    if (!creds) return;

    const { name, language, category, components } = req.body || {};
    if (!name || !language || !category || !Array.isArray(components)) {
      return res.status(400).json({ error: "name, language, category, and components are required" });
    }

    // Header sample files are read from object storage by key: they must belong to this tenant.
    const tenantId = req.auth!.tenantId;
    for (const key of collectMediaStorageKeys(components)) {
      if (!isSafeMediaKey(key) || !tenantOwnsKey(tenantId, key)) {
        return res.status(404).json({ error: "Media file not found" });
      }
    }

    const carouselError = validateCarouselTemplate(category, components);
    if (carouselError) {
      return res.status(400).json({ error: carouselError, code: "INVALID_CAROUSEL_TEMPLATE" });
    }

    try {
      const result = await createTemplate(creds.wabaId, creds.accessToken, creds.apiBaseUrl, {
        name,
        language,
        category,
        components,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Failed to create template" });
    }
  })
);
