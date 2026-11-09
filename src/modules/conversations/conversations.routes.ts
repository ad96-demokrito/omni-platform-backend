import { Router } from "express";
import multer from "multer";
import { AuthedRequest, requireAuth, requireRole } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { httpError, isUuid } from "../../utils/http-error";
import {
  CONVERSATION_STATUSES,
  ConversationActor,
  ConversationFilters,
  ConversationStatus,
  listConversations,
  getConversation,
  assignAgent,
  assignTeam,
  claimConversation,
  updateConversationStatus,
  resumeBotForConversation,
} from "./conversations.service";
import { listMessages, sendOutboundMessage } from "../messages/messages.service";
import { v4 as uuidv4 } from "uuid";
import { deleteMedia, uploadMedia } from "../../db/object-storage";
import { logger } from "../../utils/logger";
import { classifyUpload } from "../../utils/media-types";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
});

export const conversationsRouter = Router();
conversationsRouter.use(requireAuth);

/** Viewers are read-only: everything that changes a conversation needs one of these roles. */
const canWorkConversations = requireRole("owner", "admin", "agent");

const actorOf = (req: AuthedRequest): ConversationActor => ({
  userId: req.auth!.userId,
  email: req.auth!.email,
  ipAddress: req.ip,
});

function conversationIdOf(req: AuthedRequest): string {
  if (!isUuid(req.params.id)) throw httpError(400, "Invalid conversation id");
  return req.params.id;
}

const queryString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** Validates the inbox filters; `assignedTo=me` is resolved to the signed-in user. */
function parseListFilters(req: AuthedRequest): ConversationFilters {
  const status = queryString(req.query.status);
  const assignedTo = queryString(req.query.assignedTo);
  const teamId = queryString(req.query.teamId);

  if (status && !(CONVERSATION_STATUSES as readonly string[]).includes(status)) {
    throw httpError(400, "status must be one of: open, pending, closed");
  }
  if (assignedTo && assignedTo !== "me" && assignedTo !== "unassigned" && !isUuid(assignedTo)) {
    throw httpError(400, "assignedTo must be 'me', 'unassigned' or a user id");
  }
  if (teamId && !isUuid(teamId)) throw httpError(400, "teamId must be a team id");

  return {
    status: status as ConversationStatus | undefined,
    assignedTo: assignedTo === "me" ? req.auth!.userId : assignedTo,
    teamId,
  };
}

conversationsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await listConversations(req.auth!.tenantId, parseListFilters(req)));
  })
);

conversationsRouter.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const conv = await getConversation(req.auth!.tenantId, req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    res.json(conv);
  })
);

conversationsRouter.get(
  "/:id/messages",
  asyncHandler(async (req: AuthedRequest, res) => {
    const messages = await listMessages(req.auth!.tenantId, req.params.id);
    res.json(messages);
  })
);

conversationsRouter.post(
  "/:id/messages",
  asyncHandler(async (req: AuthedRequest, res) => {
    const {
      text,
      type = "text",
      mediaUrl,
      mediaStorageKey,
      filename,
      templateName,
      templateLanguage,
      templateParams,
      headerType,
      headerValue,
    } = req.body || {};

    if (type === "text" && (!text || !text.trim())) {
      return res.status(400).json({ error: "text is required for text messages" });
    }

    try {
      const message = await sendOutboundMessage({
        tenantId: req.auth!.tenantId,
        conversationId: req.params.id,
        senderUserId: req.auth!.userId,
        text: text?.trim(),
        type,
        mediaUrl,
        mediaStorageKey,
        filename,
        templateName,
        templateLanguage,
        templateParams,
        headerType,
        headerValue,
      });
      res.status(201).json(message);
    } catch (err: any) {
      console.error("[conversations] Outbound send error:", err);
      const statusCode = typeof err?.status === "number" && err.status >= 400 && err.status < 600
        ? err.status
        : 400;
      res.status(statusCode).json({
        error: err?.message || "Failed to send message",
      });
    }
  })
);

/**
 * POST /api/conversations/:id/media
 * Upload a media file (image, document, audio, video, sticker) and send it directly.
 */
conversationsRouter.post(
  "/:id/media",
  canWorkConversations,
  upload.single("file"),
  asyncHandler(async (req: AuthedRequest, res) => {
    const conversationId = conversationIdOf(req);
    const tenantId = req.auth!.tenantId;

    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "No file provided" });
    }

    // Check the conversation before storing anything, so a bad id never leaves an orphan file.
    if (!(await getConversation(tenantId, conversationId))) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const caption = typeof req.body.caption === "string" ? req.body.caption.trim() : typeof req.body.text === "string" ? req.body.text.trim() : undefined;
    const requestedKind = typeof req.body.type === "string" ? req.body.type : undefined;

    const { kind: messageType, contentType } = classifyUpload(file, { requestedKind });

    const sanitizedFilename = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storageKey = `${tenantId}/${conversationId}/${uuidv4()}_${sanitizedFilename}`;

    try {
      await uploadMedia({ key: storageKey, body: file.buffer, contentType });
    } catch (err) {
      logger.error("[conversations] Could not store uploaded media", err, { tenantId, conversationId });
      throw httpError(502, "Could not store the file. Please try again.");
    }

    try {
      const message = await sendOutboundMessage({
        tenantId,
        conversationId,
        senderUserId: req.auth!.userId,
        text: caption,
        type: messageType,
        mediaStorageKey: storageKey,
        filename: file.originalname,
      });

      res.status(201).json(message);
    } catch (err: any) {
      logger.warn("[conversations] Outbound media send failed", { tenantId, conversationId, reason: err?.message });
      // The message was never recorded, so the stored file would be unreachable garbage.
      await deleteMedia(storageKey).catch((cleanupErr) => {
        logger.warn("[conversations] Could not remove orphaned media", { storageKey, reason: cleanupErr?.message });
      });
      const statusCode = typeof err?.status === "number" && err.status >= 400 && err.status < 600
        ? err.status
        : 400;
      res.status(statusCode).json({
        error: err?.message || "Failed to send media message",
      });
    }
  })
);

/**
 * POST /api/conversations/:id/template
 * Send an approved WhatsApp template message (especially useful when 24h window has expired).
 */
conversationsRouter.post(
  "/:id/template",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { templateName, templateLanguage, templateParams, headerType, headerValue, mediaStorageKey, filename } = req.body || {};
    if (!templateName) {
      return res.status(400).json({ error: "templateName is required" });
    }

    try {
      const message = await sendOutboundMessage({
        tenantId: req.auth!.tenantId,
        conversationId: req.params.id,
        senderUserId: req.auth!.userId,
        type: "template",
        templateName,
        templateLanguage: templateLanguage || "en",
        templateParams: templateParams || {},
        headerType,
        headerValue,
        mediaStorageKey,
        filename,
      });
      res.status(201).json(message);
    } catch (err: any) {
      console.error("[conversations] Outbound template send error:", err);
      const statusCode = typeof err?.status === "number" && err.status >= 400 && err.status < 600
        ? err.status
        : 400;
      res.status(statusCode).json({
        error: err?.message || "Failed to send template message",
      });
    }
  })
);

/** Body: { agentUserId: string | null } — null unassigns. */
conversationsRouter.post(
  "/:id/assign",
  canWorkConversations,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { agentUserId } = req.body || {};
    if (agentUserId !== null && !isUuid(agentUserId)) {
      throw httpError(400, "agentUserId must be a user id, or null to unassign");
    }
    await assignAgent(req.auth!.tenantId, conversationIdOf(req), agentUserId, actorOf(req));
    res.status(204).send();
  })
);

/** Body: { teamId: string | null } — null clears the team. */
conversationsRouter.post(
  "/:id/team",
  canWorkConversations,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { teamId } = req.body || {};
    if (teamId !== null && !isUuid(teamId)) {
      throw httpError(400, "teamId must be a team id, or null to clear the team");
    }
    await assignTeam(req.auth!.tenantId, conversationIdOf(req), teamId, actorOf(req));
    res.status(204).send();
  })
);

conversationsRouter.post(
  "/:id/claim",
  canWorkConversations,
  asyncHandler(async (req: AuthedRequest, res) => {
    await claimConversation(req.auth!.tenantId, conversationIdOf(req), actorOf(req));
    res.status(204).send();
  })
);

conversationsRouter.patch(
  "/:id/status",
  canWorkConversations,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { status } = req.body || {};
    if (!(CONVERSATION_STATUSES as readonly string[]).includes(status)) {
      throw httpError(400, "Valid status ('open', 'pending', 'closed') is required");
    }
    await updateConversationStatus(req.auth!.tenantId, conversationIdOf(req), status, actorOf(req));
    res.status(204).send();
  })
);

conversationsRouter.post(
  "/:id/resume-bot",
  canWorkConversations,
  asyncHandler(async (req: AuthedRequest, res) => {
    await resumeBotForConversation(req.auth!.tenantId, conversationIdOf(req), actorOf(req));
    res.json({ success: true, message: "AI flow and autonomous reply mode resumed for conversation" });
  })
);
