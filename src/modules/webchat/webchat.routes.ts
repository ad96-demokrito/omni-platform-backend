import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { uploadMedia } from "../../db/object-storage";
import { rateLimitByIp } from "../../middleware/rate-limit";
import { classifyUpload, MEDIA_MAX_BYTES } from "../../utils/media-types";
import { isSafeMediaKey, signedMediaUrl } from "../media/media.service";
import { getVisitorHandoffState } from "../conversations/conversations.service";
import { isAgentTyping } from "../conversations/agent-typing";
import { listMessages } from "../messages/messages.service";
import { emitRealtimeEvent } from "../realtime/websocket.service";
import {
  listWebchatWidgets,
  getWebchatWidgetById,
  createWebchatWidget,
  updateWebchatWidget,
  deleteWebchatWidget,
  getPublicWidgetConfig,
  initVisitorSession,
  sendVisitorMessage,
  VisitorAuthPayload,
} from "./webchat.service";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MEDIA_MAX_BYTES.document }, // per-type limits are enforced by classifyUpload
});

const MAX_VISITOR_TEXT_LENGTH = 4000;
const MAX_FILENAME_LENGTH = 255;
const VISITOR_MEDIA_TYPES = ["image", "video", "audio", "document"];

export interface VisitorRequest extends Request {
  visitor?: VisitorAuthPayload;
}

/**
 * Middleware: Verify stateless visitor JWT token
 */
export function requireVisitorAuth(req: VisitorRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token =
    (authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null) ||
    (typeof req.query.token === "string" ? req.query.token : null);

  if (!token) {
    return res.status(401).json({ error: "Visitor authentication token required" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (!decoded.isVisitor && decoded.role !== "visitor") {
      return res.status(403).json({ error: "Invalid visitor token" });
    }
    if (!decoded.tenantId || !decoded.conversationId) {
      return res.status(403).json({ error: "Incomplete visitor token claims" });
    }

    req.visitor = {
      role: "visitor",
      isVisitor: true,
      tenantId: decoded.tenantId,
      channelId: decoded.channelId,
      contactId: decoded.contactId,
      conversationId: decoded.conversationId,
      visitorSessionId: decoded.visitorSessionId,
    };
    next();
  } catch (err: any) {
    return res.status(401).json({ error: "Visitor session expired or invalid", details: err.message });
  }
}

export const webchatRouter = Router();

// Enable Cross-Origin Script Execution & Embedding for Public Webchat Routes
webchatRouter.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, x-parent-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("Content-Security-Policy", "frame-ancestors *");
  res.removeHeader("X-Frame-Options");
  if (_req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ============================================================================
// 1. PUBLIC VISITOR API ENDPOINTS
// ============================================================================

/**
 * GET /api/webchat/config/:widgetKey
 * Public endpoint to load widget appearance, branding, and online status.
 */
webchatRouter.get(
  "/config/:widgetKey",
  asyncHandler(async (req: Request, res: Response) => {
    const { widgetKey } = req.params;
    const origin =
      (req.query.parentOrigin as string) ||
      (req.headers["x-parent-origin"] as string) ||
      req.headers.origin ||
      req.headers.referer;
    const config = await getPublicWidgetConfig(widgetKey, typeof origin === "string" ? origin : undefined);
    res.json(config);
  })
);

/**
 * POST /api/webchat/init
 * Initialize or resume a stateless visitor session and load conversation history.
 */
webchatRouter.post(
  "/init",
  asyncHandler(async (req: Request, res: Response) => {
    const { widgetKey, visitorSessionId, contactName, contactEmail, metadata, parentOrigin } = req.body;
    if (!widgetKey) {
      return res.status(400).json({ error: "widgetKey is required" });
    }

    const origin =
      (req.query.parentOrigin as string) ||
      parentOrigin ||
      (req.headers["x-parent-origin"] as string) ||
      req.headers.origin ||
      req.headers.referer;

    const session = await initVisitorSession({
      widgetKey,
      visitorSessionId,
      contactName,
      contactEmail,
      metadata,
      originHeader: typeof origin === "string" ? origin : undefined,
    });

    res.json(session);
  })
);

/**
 * GET /api/webchat/messages
 * Fetch conversation message history for an authenticated visitor.
 */
webchatRouter.get(
  "/messages",
  requireVisitorAuth,
  asyncHandler(async (req: VisitorRequest, res: Response) => {
    const visitor = req.visitor!;
    const [messages, handoff, agentTyping] = await Promise.all([
      listMessages(visitor.tenantId, visitor.conversationId),
      getVisitorHandoffState(visitor.tenantId, visitor.conversationId),
      isAgentTyping(visitor.tenantId, visitor.conversationId),
    ]);
    // `handoff` is the visitor-safe view: who is answering (bot, waiting for an agent, or an agent's first name).
    res.json({ messages, handoff, agentTyping });
  })
);

/**
 * POST /api/webchat/messages
 * Send a message from the visitor into the live chat conversation.
 */
webchatRouter.post(
  "/messages",
  rateLimitByIp("webchat-messages", 120, 60),
  requireVisitorAuth,
  asyncHandler(async (req: VisitorRequest, res: Response) => {
    const visitor = req.visitor!;
    const body = (req.body || {}) as Record<string, unknown>;

    if (body.text !== undefined && (typeof body.text !== "string" || body.text.length > MAX_VISITOR_TEXT_LENGTH)) {
      return res.status(400).json({ error: `Message text must be at most ${MAX_VISITOR_TEXT_LENGTH} characters` });
    }

    // Visitors may only attach a file they uploaded to this conversation. Any client-supplied URL is
    // ignored: the stored key is the only reference, and agents/the widget get a fresh signed link from it.
    let mediaStorageKey: string | undefined;
    let type: string | undefined;
    let filename: string | undefined;
    if (body.mediaStorageKey !== undefined) {
      const key = body.mediaStorageKey;
      if (!isSafeMediaKey(key) || !key.startsWith(`webchat/${visitor.tenantId}/${visitor.conversationId}/`)) {
        return res.status(400).json({ error: "Invalid attachment reference" });
      }
      mediaStorageKey = key;
      type = typeof body.type === "string" && VISITOR_MEDIA_TYPES.includes(body.type) ? body.type : "document";
      filename = typeof body.filename === "string" ? body.filename.slice(0, MAX_FILENAME_LENGTH) : undefined;
    }

    const message = await sendVisitorMessage({
      tenantId: visitor.tenantId,
      channelId: visitor.channelId,
      conversationId: visitor.conversationId,
      contactId: visitor.contactId,
      visitorSessionId: visitor.visitorSessionId,
      text: typeof body.text === "string" ? body.text : undefined,
      mediaStorageKey,
      filename,
      type,
    });

    res.status(201).json({ message });
  })
);

/**
 * POST /api/webchat/typing
 * Broadcast visitor typing indicator to tenant agents in real time.
 */
webchatRouter.post(
  "/typing",
  requireVisitorAuth,
  asyncHandler(async (req: VisitorRequest, res: Response) => {
    const visitor = req.visitor!;
    const { isTyping } = req.body;

    await emitRealtimeEvent(
      visitor.tenantId,
      "conversation:typing",
      {
        conversationId: visitor.conversationId,
        isTyping: Boolean(isTyping),
        sender: "visitor",
        userId: visitor.contactId,
      },
      { conversationId: visitor.conversationId }
    );

    res.json({ success: true });
  })
);

/**
 * POST /api/webchat/upload
 * Securely upload image, document, or audio attachment for visitor chat.
 */
webchatRouter.post(
  "/upload",
  rateLimitByIp("webchat-upload", 30, 10 * 60),
  requireVisitorAuth,
  upload.single("file"),
  asyncHandler(async (req: VisitorRequest, res: Response) => {
    const visitor = req.visitor!;
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { kind, contentType } = classifyUpload(req.file);

    const safeFilename = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `webchat/${visitor.tenantId}/${visitor.conversationId}/${uuidv4()}_${safeFilename}`;

    await uploadMedia({ key, body: req.file.buffer, contentType });

    res.json({
      key,
      url: signedMediaUrl(key),
      type: kind,
      filename: req.file.originalname,
      contentType,
      size: req.file.size,
    });
  })
);

/**
 * GET /api/webchat/embed.js
 * Standalone embed script loader that customers can include in their website HTML.
 * Renders a fully isolated, modern, zero-dependency live chat widget using the browser's Shadow DOM.
 * Eliminates all cross-origin iframe restrictions and X-Frame-Options blocking.
 */
webchatRouter.get("/embed.js", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.removeHeader("X-Frame-Options");

  const host =
    req.get("x-forwarded-host") ||
    req.get("host") ||
    "localhost:4000";
  const protocol =
    req.get("x-forwarded-proto") ||
    (req.protocol === "https" ? "https" : "http");
  const baseUrl = `${protocol}://${host}`;

  const js = `
(function() {
  'use strict';
  if (document.getElementById('omni-webchat-root')) return;

  var currentScript = document.currentScript || (function() {
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      var s = scripts[i].src || '';
      if (s.indexOf('embed.js') !== -1 || s.indexOf('webchat') !== -1) return scripts[i];
    }
    return scripts[scripts.length - 1];
  })();

  var widgetKey = null;
  var scriptSrc = (currentScript && currentScript.src) ? currentScript.src : '';
  if (scriptSrc) {
    var match = scriptSrc.match(/[?&]key=([^&#]*)/);
    if (match) widgetKey = decodeURIComponent(match[1]);
  }
  if (!widgetKey && window.OmniChatConfig && window.OmniChatConfig.widgetKey) {
    widgetKey = window.OmniChatConfig.widgetKey;
  }
  if (!widgetKey) {
    console.warn('[OmniChat] Missing widget key in embed script tag (?key=...).');
    return;
  }

  var scriptOrigin = '';
  if (scriptSrc) {
    try {
      var parsedUrl = new URL(scriptSrc, window.location.href);
      scriptOrigin = parsedUrl.origin;
    } catch(e) {}
  }
  var baseHost = (window.OmniChatConfig && window.OmniChatConfig.appUrl) || scriptOrigin || '${baseUrl}';
  baseHost = baseHost.replace(/\\/+$/, '');
  var parentOrigin = window.location.origin || (window.location.protocol + '//' + window.location.host);

  // Create Container & Attach Shadow DOM for 100% CSS & DOM Isolation
  var hostDiv = document.createElement('div');
  hostDiv.id = 'omni-webchat-root';
  hostDiv.style.position = 'fixed';
  hostDiv.style.zIndex = '2147483647';
  hostDiv.style.pointerEvents = 'none';
  hostDiv.style.bottom = '0';
  hostDiv.style.right = '0';
  hostDiv.style.left = '0';
  hostDiv.style.top = '0';
  hostDiv.style.width = '100%';
  hostDiv.style.height = '100%';

  var shadow = hostDiv.attachShadow ? hostDiv.attachShadow({ mode: 'open' }) : hostDiv;

  var state = {
    config: null,
    isOpen: false,
    token: null,
    visitorSessionId: null,
    contactName: '',
    contactEmail: '',
    isLeadCaptured: false,
    messages: [],
    unreadCount: 0,
    isTyping: false,
    agentTyping: false,
    isUploading: false,
    pollTimer: null,
    typingTimeout: null,
  };

  // Safe localStorage helper
  function getStorage(k) {
    try { return localStorage.getItem('omni_wc_' + widgetKey + '_' + k); } catch(e) { return null; }
  }
  function setStorage(k, v) {
    try { localStorage.setItem('omni_wc_' + widgetKey + '_' + k, v); } catch(e) {}
  }

  state.token = getStorage('token');
  state.visitorSessionId = getStorage('sid') || ('guest_' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36));
  setStorage('sid', state.visitorSessionId);
  state.contactName = getStorage('name') || '';
  state.contactEmail = getStorage('email') || '';
  if (state.contactName || state.contactEmail) {
    state.isLeadCaptured = true;
  }

  // Inject Styles inside Shadow Root
  var style = document.createElement('style');
  style.textContent = \`
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    :host {
      --omni-primary: #2563eb;
      --omni-primary-hover: #1d4ed8;
      --omni-bg: #ffffff;
      --omni-text: #1e293b;
      --omni-subtext: #64748b;
      --omni-bubble-bot: #f1f5f9;
      --omni-bubble-bot-text: #0f172a;
      --omni-border: #e2e8f0;
      pointer-events: none;
    }
    .omni-launcher {
      position: fixed;
      bottom: 24px;
      right: 24px;
      height: 60px;
      min-width: 60px;
      border-radius: 30px;
      background: var(--omni-primary);
      color: #ffffff;
      border: none;
      box-shadow: 0 8px 24px -4px rgba(0, 0, 0, 0.2), 0 4px 12px -2px rgba(0, 0, 0, 0.12);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 20px 0 16px;
      gap: 10px;
      pointer-events: auto;
      transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.25s ease, background-color 0.2s ease;
      z-index: 2147483647;
      user-select: none;
    }
    .omni-launcher:hover {
      transform: scale(1.05);
      box-shadow: 0 12px 28px -4px rgba(0, 0, 0, 0.28);
    }
    .omni-launcher.pos-left {
      right: auto;
      left: 24px;
    }
    .omni-launcher.circle-only {
      padding: 0;
      width: 60px;
      min-width: 60px;
    }
    .omni-launcher-icon {
      width: 28px;
      height: 28px;
      fill: currentColor;
      transition: transform 0.25s ease;
    }
    .omni-launcher-text {
      font-size: 15px;
      font-weight: 600;
      white-space: nowrap;
    }
    .omni-badge {
      position: absolute;
      top: -4px;
      right: -4px;
      background: #ef4444;
      color: #ffffff;
      font-size: 12px;
      font-weight: 700;
      min-width: 22px;
      height: 22px;
      border-radius: 11px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 6px;
      border: 2px solid #ffffff;
      box-shadow: 0 2px 5px rgba(0,0,0,0.2);
    }
    .omni-window {
      position: fixed;
      bottom: 96px;
      right: 24px;
      width: 380px;
      max-width: calc(100vw - 32px);
      height: 600px;
      max-height: calc(100vh - 120px);
      background: #ffffff;
      border-radius: 20px;
      box-shadow: 0 20px 40px -8px rgba(0, 0, 0, 0.22), 0 1px 3px rgba(0, 0, 0, 0.08);
      border: 1px solid var(--omni-border);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      pointer-events: auto;
      opacity: 0;
      transform: scale(0.92) translateY(20px);
      transform-origin: bottom right;
      transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1), transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      visibility: hidden;
      z-index: 2147483646;
    }
    .omni-window.pos-left {
      right: auto;
      left: 24px;
      transform-origin: bottom left;
    }
    .omni-window.open {
      opacity: 1;
      transform: scale(1) translateY(0);
      visibility: visible;
    }
    .omni-header {
      background: var(--omni-primary);
      color: #ffffff;
      padding: 16px 18px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-top-left-radius: 20px;
      border-top-right-radius: 20px;
    }
    .omni-header-info {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .omni-avatar-wrap {
      position: relative;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.2);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .omni-avatar-wrap svg {
      width: 24px;
      height: 24px;
      fill: #ffffff;
    }
    .omni-status-dot {
      position: absolute;
      bottom: 0;
      right: 0;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #22c55e;
      border: 2px solid var(--omni-primary);
    }
    .omni-status-dot.offline {
      background: #94a3b8;
    }
    .omni-title-wrap h3 {
      font-size: 16px;
      font-weight: 700;
      line-height: 1.2;
    }
    .omni-title-wrap p {
      font-size: 12px;
      opacity: 0.88;
      margin-top: 2px;
    }
    .omni-close-btn {
      background: transparent;
      border: none;
      color: #ffffff;
      cursor: pointer;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s;
    }
    .omni-close-btn:hover {
      background: rgba(255, 255, 255, 0.2);
    }
    .omni-close-btn svg {
      width: 20px;
      height: 20px;
      fill: currentColor;
    }
    .omni-offline-banner {
      background: #fef3c7;
      color: #92400e;
      font-size: 12px;
      padding: 8px 14px;
      line-height: 1.4;
      border-bottom: 1px solid #fde68a;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .omni-messages {
      flex: 1;
      padding: 16px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: #f8fafc;
    }
    .omni-msg-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: 82%;
    }
    .omni-msg-group.inbound {
      align-self: flex-end;
      align-items: flex-end;
    }
    .omni-msg-group.outbound {
      align-self: flex-start;
      align-items: flex-start;
    }
    .omni-bubble {
      padding: 10px 14px;
      border-radius: 16px;
      font-size: 14px;
      line-height: 1.45;
      word-break: break-word;
      white-space: pre-wrap;
      position: relative;
    }
    .omni-msg-group.inbound .omni-bubble {
      background: var(--omni-primary);
      color: #ffffff;
      border-bottom-right-radius: 4px;
    }
    .omni-msg-group.outbound .omni-bubble {
      background: #ffffff;
      color: var(--omni-bubble-bot-text);
      border: 1px solid var(--omni-border);
      border-bottom-left-radius: 4px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    }
    .omni-bubble img {
      max-width: 100%;
      border-radius: 8px;
      margin-top: 4px;
      display: block;
      cursor: pointer;
    }
    .omni-bubble video {
      max-width: 100%;
      border-radius: 8px;
      margin-top: 4px;
      display: block;
    }
    .omni-bubble audio {
      width: 100%;
      min-width: 200px;
      margin-top: 4px;
      display: block;
    }
    .omni-bubble a {
      color: inherit;
      text-decoration: underline;
    }
    .omni-sender {
      font-size: 10px;
      font-weight: 600;
      color: var(--omni-subtext);
      padding: 0 4px 2px;
    }
    .omni-pending .omni-bubble.omni-error {
      background: #fef2f2;
      color: #b91c1c;
      border: 1px solid #fecaca;
    }
    .omni-time {
      font-size: 10px;
      color: var(--omni-subtext);
      margin-top: 2px;
      padding: 0 4px;
    }
    .omni-lead-card {
      background: #ffffff;
      border: 1px solid var(--omni-border);
      border-radius: 14px;
      padding: 14px;
      margin-bottom: 6px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.04);
    }
    .omni-lead-card h4 {
      font-size: 13px;
      font-weight: 700;
      color: var(--omni-text);
      margin-bottom: 4px;
    }
    .omni-lead-card p {
      font-size: 12px;
      color: var(--omni-subtext);
      margin-bottom: 10px;
    }
    .omni-lead-card input {
      width: 100%;
      padding: 8px 12px;
      font-size: 13px;
      border: 1px solid var(--omni-border);
      border-radius: 8px;
      margin-bottom: 8px;
      outline: none;
    }
    .omni-lead-card input:focus {
      border-color: var(--omni-primary);
    }
    .omni-lead-card button {
      width: 100%;
      padding: 8px;
      background: var(--omni-primary);
      color: #ffffff;
      font-weight: 600;
      font-size: 13px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .omni-lead-card button:hover {
      opacity: 0.92;
    }
    .omni-typing-indicator {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px 14px;
      background: #ffffff;
      border: 1px solid var(--omni-border);
      border-radius: 16px;
      width: fit-content;
      margin-bottom: 4px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    }
    .omni-typing-dot {
      width: 6px;
      height: 6px;
      background: var(--omni-subtext);
      border-radius: 50%;
      animation: omni-bounce 1.4s infinite ease-in-out both;
    }
    .omni-typing-dot:nth-child(1) { animation-delay: -0.32s; }
    .omni-typing-dot:nth-child(2) { animation-delay: -0.16s; }
    @keyframes omni-bounce {
      0%, 80%, 100% { transform: scale(0); }
      40% { transform: scale(1); }
    }
    .omni-footer {
      padding: 10px 14px 8px;
      background: #ffffff;
      border-top: 1px solid var(--omni-border);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .omni-input-row {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      background: #f8fafc;
      border: 1px solid var(--omni-border);
      border-radius: 14px;
      padding: 4px 6px 4px 12px;
      transition: border-color 0.2s;
    }
    .omni-input-row:focus-within {
      border-color: var(--omni-primary);
      background: #ffffff;
    }
    .omni-textarea {
      flex: 1;
      border: none;
      background: transparent;
      resize: none;
      font-size: 14px;
      color: var(--omni-text);
      max-height: 90px;
      min-height: 24px;
      height: 24px;
      line-height: 20px;
      padding: 2px 0;
      outline: none;
    }
    .omni-textarea::placeholder {
      color: #94a3b8;
    }
    .omni-action-btn {
      background: transparent;
      border: none;
      color: var(--omni-subtext);
      cursor: pointer;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s, background-color 0.15s;
      flex-shrink: 0;
    }
    .omni-action-btn:hover {
      color: var(--omni-primary);
      background: #f1f5f9;
    }
    .omni-send-btn {
      background: var(--omni-primary);
      color: #ffffff;
    }
    .omni-send-btn:hover {
      background: var(--omni-primary);
      opacity: 0.9;
      color: #ffffff;
    }
    .omni-send-btn svg, .omni-action-btn svg {
      width: 18px;
      height: 18px;
      fill: currentColor;
    }
    .omni-branding {
      text-align: center;
      font-size: 10px;
      color: #94a3b8;
      text-decoration: none;
      user-select: none;
    }
    .omni-branding span {
      font-weight: 600;
      color: #64748b;
    }
    @media (max-width: 480px) {
      .omni-window {
        width: 100vw;
        max-width: 100vw;
        height: 100vh;
        max-height: 100vh;
        bottom: 0;
        right: 0;
        left: 0;
        border-radius: 0;
        border: none;
      }
      .omni-header {
        border-radius: 0;
        padding-top: max(16px, env(safe-area-inset-top));
      }
      .omni-launcher {
        bottom: 16px;
        right: 16px;
      }
    }
  \`;
  shadow.appendChild(style);

  // Widget Markup Structure
  var widgetContainer = document.createElement('div');
  widgetContainer.innerHTML = \`
    <button class="omni-launcher" id="launcherBtn" aria-label="Open Live Chat">
      <svg class="omni-launcher-icon" id="launcherIconSvg" viewBox="0 0 24 24">
        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>
      </svg>
      <span class="omni-launcher-text" id="launcherTextSpan">Chat with us</span>
      <div class="omni-badge" id="unreadBadge" style="display: none;">0</div>
    </button>

    <div class="omni-window" id="chatWindow">
      <div class="omni-header">
        <div class="omni-header-info">
          <div class="omni-avatar-wrap">
            <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 3c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm0 14.2c-2.5 0-4.71-1.28-6-3.22.03-1.99 4-3.08 6-3.08 1.99 0 5.97 1.09 6 3.08-1.29 1.94-3.5 3.22-6 3.22z"/></svg>
            <div class="omni-status-dot" id="statusDot"></div>
          </div>
          <div class="omni-title-wrap">
            <h3 id="widgetTitle">Live Chat</h3>
            <p id="widgetSubtitle">We usually reply in minutes</p>
          </div>
        </div>
        <button class="omni-close-btn" id="closeBtn" aria-label="Close Chat">
          <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>

      <div class="omni-offline-banner" id="offlineBanner" style="display: none;">
        <span>⏰</span> <span id="offlineBannerText">We are currently offline. Leave a message!</span>
      </div>

      <div class="omni-messages" id="messagesList">
        <div class="omni-msg-group outbound" id="greetingMsgGroup">
          <div class="omni-bubble" id="greetingBubble">Hello! How can we help you today?</div>
          <div class="omni-time">Just now</div>
        </div>
      </div>

      <div class="omni-footer">
        <div class="omni-input-row">
          <textarea class="omni-textarea" id="chatInput" placeholder="Type your message..." rows="1"></textarea>
          <input type="file" id="fileInput" style="display: none;" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv" />
          <button class="omni-action-btn" id="attachBtn" title="Attach File" aria-label="Attach File">
            <svg viewBox="0 0 24 24"><path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/></svg>
          </button>
          <button class="omni-action-btn omni-send-btn" id="sendBtn" title="Send" aria-label="Send Message">
            <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
        <div class="omni-branding">
          Powered by <span>Omni-Platform</span>
        </div>
      </div>
    </div>
  \`;
  shadow.appendChild(widgetContainer);

  // DOM Elements inside Shadow
  var launcherBtn = shadow.getElementById('launcherBtn');
  var launcherIconSvg = shadow.getElementById('launcherIconSvg');
  var launcherTextSpan = shadow.getElementById('launcherTextSpan');
  var unreadBadge = shadow.getElementById('unreadBadge');
  var chatWindow = shadow.getElementById('chatWindow');
  var closeBtn = shadow.getElementById('closeBtn');
  var widgetTitle = shadow.getElementById('widgetTitle');
  var widgetSubtitle = shadow.getElementById('widgetSubtitle');
  var statusDot = shadow.getElementById('statusDot');
  var offlineBanner = shadow.getElementById('offlineBanner');
  var offlineBannerText = shadow.getElementById('offlineBannerText');
  var messagesList = shadow.getElementById('messagesList');
  var greetingBubble = shadow.getElementById('greetingBubble');
  var chatInput = shadow.getElementById('chatInput');
  var fileInput = shadow.getElementById('fileInput');
  var attachBtn = shadow.getElementById('attachBtn');
  var sendBtn = shadow.getElementById('sendBtn');

  // Toggle Chat Window
  function toggleChat(open) {
    state.isOpen = (typeof open === 'boolean') ? open : !state.isOpen;
    if (state.isOpen) {
      chatWindow.classList.add('open');
      launcherIconSvg.innerHTML = '<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>';
      state.unreadCount = 0;
      unreadBadge.style.display = 'none';
      setTimeout(function() { chatInput.focus(); }, 100);
      scrollToBottom();
      startPolling();
    } else {
      chatWindow.classList.remove('open');
      launcherIconSvg.innerHTML = '<path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/>';
    }
  }

  launcherBtn.addEventListener('click', function() { toggleChat(); });
  closeBtn.addEventListener('click', function() { toggleChat(false); });

  function scrollToBottom() {
    setTimeout(function() {
      messagesList.scrollTop = messagesList.scrollHeight;
    }, 50);
  }

  // Auto-resize input
  chatInput.addEventListener('input', function() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 90) + 'px';
    handleTyping();
  });

  chatInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  sendBtn.addEventListener('click', function() { handleSend(); });

  attachBtn.addEventListener('click', function() { fileInput.click(); });
  fileInput.addEventListener('change', function() {
    if (fileInput.files && fileInput.files[0]) {
      uploadAttachment(fileInput.files[0]);
    }
    // Clear the selection so choosing the same file again still fires 'change'.
    fileInput.value = '';
  });

  // API Call Wrapper
  function apiFetch(endpoint, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    opts.headers['x-parent-origin'] = parentOrigin;
    if (state.token) {
      opts.headers['Authorization'] = 'Bearer ' + state.token;
    }
    var sep = endpoint.indexOf('?') === -1 ? '?' : '&';
    var url = baseHost + endpoint + sep + 'parentOrigin=' + encodeURIComponent(parentOrigin);
    return fetch(url, opts).then(function(res) {
      if (!res.ok) {
        // Keep the server's message (err.error) so callers can show it; fall back to the status code.
        return res.json().catch(function() { return null; }).then(function(body) {
          var failure = new Error((body && body.error) || ('HTTP ' + res.status));
          failure.status = res.status;
          failure.error = body && body.error;
          throw failure;
        });
      }
      return res.json();
    });
  }

  // Load Widget Config
  apiFetch('/api/webchat/config/' + encodeURIComponent(widgetKey))
    .then(function(config) {
      state.config = config;
      applyConfig(config);
      initSession();
    })
    .catch(function(err) {
      console.warn('[OmniChat] Failed to load widget configuration:', err);
    });

  function applyConfig(cfg) {
    if (cfg.primaryColor) {
      style.textContent += \` :host { --omni-primary: \${cfg.primaryColor}; } \`;
    }
    if (cfg.title) widgetTitle.textContent = cfg.title;
    if (cfg.subtitle) widgetSubtitle.textContent = cfg.subtitle;
    if (cfg.greetingMessage) greetingBubble.textContent = cfg.greetingMessage;
    if (cfg.placeholderText) chatInput.placeholder = cfg.placeholderText;
    if (cfg.launcherText) launcherTextSpan.textContent = cfg.launcherText;
    if (!cfg.launcherText || cfg.launcherText.trim() === '') {
      launcherBtn.classList.add('circle-only');
      launcherTextSpan.style.display = 'none';
    }
    if (cfg.position === 'bottom-left') {
      launcherBtn.classList.add('pos-left');
      chatWindow.classList.add('pos-left');
    }
    if (cfg.isOnline) {
      statusDot.classList.remove('offline');
      offlineBanner.style.display = 'none';
    } else {
      statusDot.classList.add('offline');
      if (cfg.offlineMessage) {
        offlineBannerText.textContent = cfg.offlineMessage;
        offlineBanner.style.display = 'flex';
      }
    }
  }

  // Init or Resume Session
  function initSession() {
    apiFetch('/api/webchat/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        widgetKey: widgetKey,
        visitorSessionId: state.visitorSessionId,
        contactName: state.contactName,
        contactEmail: state.contactEmail,
        parentOrigin: parentOrigin
      })
    }).then(function(res) {
      if (res.token) {
        state.token = res.token;
        setStorage('token', res.token);
      }
      if (res.messages && res.messages.length > 0) {
        renderMessages(res.messages);
      }
      checkLeadCapturePrompt();
    }).catch(function(e) {
      console.warn('[OmniChat] Session init notice:', e);
    });
  }

  function checkLeadCapturePrompt() {
    if (!state.config) return;
    if ((state.config.requireName || state.config.requireEmail) && !state.isLeadCaptured) {
      var leadDiv = document.createElement('div');
      leadDiv.id = 'omniLeadCard';
      leadDiv.className = 'omni-lead-card';
      leadDiv.innerHTML = \`
        <h4>Welcome to Live Chat!</h4>
        <p>Please enter your contact details so our team can follow up with you.</p>
        \${state.config.requireName ? '<input type="text" id="leadNameInput" placeholder="Your Name" />' : ''}
        \${state.config.requireEmail ? '<input type="email" id="leadEmailInput" placeholder="Your Email Address" />' : ''}
        <button id="leadSubmitBtn">Start Chatting</button>
      \`;
      messagesList.appendChild(leadDiv);
      scrollToBottom();

      var leadSubmitBtn = leadDiv.querySelector('#leadSubmitBtn');
      leadSubmitBtn.addEventListener('click', function() {
        var nameInput = leadDiv.querySelector('#leadNameInput');
        var emailInput = leadDiv.querySelector('#leadEmailInput');
        var nameVal = nameInput ? nameInput.value.trim() : '';
        var emailVal = emailInput ? emailInput.value.trim() : '';

        if (state.config.requireName && !nameVal) {
          alert('Please enter your name');
          return;
        }
        if (state.config.requireEmail && (!emailVal || emailVal.indexOf('@') === -1)) {
          alert('Please enter a valid email address');
          return;
        }

        state.contactName = nameVal;
        state.contactEmail = emailVal;
        state.isLeadCaptured = true;
        setStorage('name', nameVal);
        setStorage('email', emailVal);

        leadDiv.remove();
        initSession();
      });
    }
  }

  // Render Messages
  // Media URLs come back relative to the API when PUBLIC_API_URL is not set; on a customer's site
  // they must point at our host. Anything that is not http(s) is dropped.
  function resolveMediaUrl(url) {
    if (typeof url !== 'string' || !url) return '';
    var absolute = /^https?:\\/\\//i.test(url) ? url : baseHost + (url.charAt(0) === '/' ? '' : '/') + url;
    return /^https?:\\/\\//i.test(absolute) ? absolute : '';
  }

  function appendMedia(bubble, msg) {
    var url = resolveMediaUrl(msg.mediaUrl || msg.media_url);
    if (!url) return false;
    var type = msg.type === 'file' ? 'document' : msg.type;
    var filename = (msg.content && msg.content.filename) || 'Attachment';

    if (type === 'image' || type === 'sticker') {
      var link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      var img = document.createElement('img');
      img.src = url;
      img.alt = filename;
      img.loading = 'lazy';
      link.appendChild(img);
      bubble.appendChild(link);
    } else if (type === 'video') {
      var video = document.createElement('video');
      video.src = url;
      video.controls = true;
      video.preload = 'metadata';
      bubble.appendChild(video);
    } else if (type === 'audio') {
      var audio = document.createElement('audio');
      audio.src = url;
      audio.controls = true;
      audio.preload = 'none';
      bubble.appendChild(audio);
    } else {
      var doc = document.createElement('a');
      doc.href = url;
      doc.target = '_blank';
      doc.rel = 'noopener noreferrer';
      doc.textContent = '📄 ' + filename;
      bubble.appendChild(doc);
    }
    return true;
  }

  // The server fills "[Image]" / "[Document: x]" as text when a file has no caption; it is not for display.
  var MEDIA_PLACEHOLDER_TEXT = /^\\[(Image|Video|Audio|Sticker|Document)(: [^\\]]*)?\\]$/;

  function renderMessages(msgs) {
    if (!Array.isArray(msgs)) return;
    state.messages = msgs;

    // The 3.5s poll returns the same list most of the time; rebuilding it would flicker images and
    // reset scrolling, so only redraw when something changed.
    var signature = (state.agentFirstName || '') + '#' + msgs.map(function(m) {
      return [m.id, m.status, m.mediaUrl || m.media_url || '', m.text || ''].join('|');
    }).join('\\n');
    if (signature === state.renderSignature && !messagesList.querySelector('.omni-optimistic')) return;
    state.renderSignature = signature;

    // Clear existing dynamic messages (keep greeting)
    var items = messagesList.querySelectorAll('.omni-dynamic-msg');
    for (var i = 0; i < items.length; i++) items[i].remove();

    msgs.forEach(function(msg) {
      var isInbound = msg.direction === 'inbound';
      var group = document.createElement('div');
      group.className = 'omni-msg-group omni-dynamic-msg ' + (isInbound ? 'inbound' : 'outbound');

      var bubble = document.createElement('div');
      bubble.className = 'omni-bubble';

      var hasMedia = appendMedia(bubble, msg);

      if (msg.text && !(hasMedia && MEDIA_PLACEHOLDER_TEXT.test(msg.text))) {
        var textNode = document.createElement('div');
        textNode.textContent = msg.text;
        bubble.appendChild(textNode);
      }

      var time = document.createElement('div');
      time.className = 'omni-time';
      var d = msg.createdAt || msg.created_at || msg.sent_at ? new Date(msg.createdAt || msg.created_at || msg.sent_at) : new Date();
      time.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      // Name the person answering, so the visitor can tell an agent from the bot.
      if (!isInbound && msg.senderType === 'agent' && state.agentFirstName) {
        var sender = document.createElement('div');
        sender.className = 'omni-sender';
        sender.textContent = state.agentFirstName;
        group.appendChild(sender);
      }

      group.appendChild(bubble);
      group.appendChild(time);
      messagesList.appendChild(group);
    });

    // Upload progress/error notes are not part of the message list; keep them below the messages.
    var pending = messagesList.querySelectorAll('.omni-pending');
    for (var p = 0; p < pending.length; p++) messagesList.appendChild(pending[p]);

    scrollToBottom();
  }

  // Send Message
  function handleSend() {
    var text = chatInput.value.trim();
    if (!text || !state.token) return;

    chatInput.value = '';
    chatInput.style.height = '24px';

    // Optimistic UI Append
    var tempGroup = document.createElement('div');
    tempGroup.className = 'omni-msg-group omni-dynamic-msg omni-optimistic inbound';
    tempGroup.innerHTML = '<div class="omni-bubble">' + escapeHtml(text) + '</div><div class="omni-time">Just now</div>';
    messagesList.appendChild(tempGroup);
    scrollToBottom();

    apiFetch('/api/webchat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text })
    }).then(function(res) {
      fetchMessages();
    }).catch(function(err) {
      console.warn('[OmniChat] Failed to send message:', err);
    });
  }

  // Upload Attachment
  // Mirrors the server's allow-list and size limits (backend utils/media-types.ts) so an unsuitable
  // file is rejected before it is uploaded. The server stays the authority.
  var UPLOAD_LIMITS_MB = { image: 5, video: 16, audio: 16, document: 50 };
  var EXTENSION_KIND = {
    jpg: 'image', jpeg: 'image', png: 'image', webp: 'image',
    mp4: 'video', '3gp': 'video', mov: 'video', webm: 'video',
    aac: 'audio', m4a: 'audio', mp3: 'audio', amr: 'audio', ogg: 'audio',
    pdf: 'document', doc: 'document', docx: 'document', xls: 'document', xlsx: 'document',
    ppt: 'document', pptx: 'document', txt: 'document', csv: 'document'
  };

  function uploadKindOf(file) {
    var mime = (file.type || '').split(';')[0].toLowerCase();
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (/^image\\/(jpeg|png|webp)$/.test(mime)) return 'image';
    if (/^video\\/(mp4|3gpp|quicktime|webm)$/.test(mime)) return 'video';
    if (/^audio\\/(aac|mp4|mpeg|amr|ogg|webm)$/.test(mime)) return 'audio';
    if (/^application\\/(pdf|msword|vnd\\.)/.test(mime) || /^text\\/(plain|csv)$/.test(mime)) return 'document';
    return EXTENSION_KIND[ext] || null;
  }

  // Progress and error notes for uploads. They live outside the polled message list (class
  // omni-pending), so the 3.5s refresh does not wipe them mid-upload.
  function showUploadNote(text, isError) {
    var node = document.createElement('div');
    node.className = 'omni-msg-group omni-pending inbound';
    var bubble = document.createElement('div');
    bubble.className = 'omni-bubble' + (isError ? ' omni-error' : '');
    if (!isError) bubble.style.opacity = '0.7';
    bubble.textContent = text;
    node.appendChild(bubble);
    messagesList.appendChild(node);
    scrollToBottom();
    if (isError) setTimeout(function() { node.remove(); }, 8000);
    return { node: node, bubble: bubble };
  }

  function uploadAttachment(file) {
    if (!state.token) return;

    var kind = uploadKindOf(file);
    if (!kind) {
      showUploadNote('This file type is not supported. Send an image, video, audio file or a document (PDF, Office, TXT, CSV).', true);
      return;
    }
    var limitMb = UPLOAD_LIMITS_MB[kind];
    if (file.size > limitMb * 1024 * 1024) {
      showUploadNote('That ' + kind + ' is too large. The limit is ' + limitMb + ' MB.', true);
      return;
    }

    var note = showUploadNote('Uploading ' + file.name + '… 0%', false);
    function fail(message) {
      note.node.remove();
      showUploadNote(message, true);
    }

    var formData = new FormData();
    formData.append('file', file);

    var xhr = new XMLHttpRequest();
    xhr.open('POST', baseHost + '/api/webchat/upload?parentOrigin=' + encodeURIComponent(parentOrigin));
    xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);
    xhr.setRequestHeader('x-parent-origin', parentOrigin);
    xhr.timeout = 120000;
    xhr.upload.onprogress = function(e) {
      if (e.lengthComputable) {
        note.bubble.textContent = 'Uploading ' + file.name + '… ' + Math.round((e.loaded / e.total) * 100) + '%';
      }
    };
    // A proxy rejecting an oversized body answers without CORS headers, which the browser reports as a network error.
    xhr.onerror = function() { fail('Upload failed. Please check your connection, or the file may be too large.'); };
    xhr.ontimeout = function() { fail('Upload timed out. Please try again.'); };
    xhr.onload = function() {
      var data = {};
      try { data = JSON.parse(xhr.responseText); } catch (e) { data = {}; }
      if (xhr.status < 200 || xhr.status >= 300 || !data.key) {
        fail(data.error || (xhr.status === 413 ? 'That file is too large to upload.' : 'Upload failed (error ' + xhr.status + ').'));
        return;
      }
      apiFetch('/api/webchat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '', mediaStorageKey: data.key, type: data.type, filename: data.filename })
      }).then(function() {
        note.node.remove();
        fetchMessages();
      }).catch(function(err) {
        fail((err && err.error) || 'Could not send the file. Please try again.');
      });
    };
    xhr.send(formData);
  }

  // Handle Typing indicator
  function handleTyping() {
    if (!state.token) return;
    if (!state.isTyping) {
      state.isTyping = true;
      apiFetch('/api/webchat/typing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isTyping: true })
      }).catch(function() {});
    }
    clearTimeout(state.typingTimeout);
    state.typingTimeout = setTimeout(function() {
      state.isTyping = false;
      apiFetch('/api/webchat/typing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isTyping: false })
      }).catch(function() {});
    }, 2500);
  }

  // Header line that tells the visitor who is answering: the bot, "connecting to an agent", or the agent's name.
  function applyHandoffState(handoff) {
    var subtitle = shadow.getElementById('widgetSubtitle');
    if (!subtitle) return;
    var current = handoff && handoff.state ? handoff.state : 'bot';
    var name = handoff && handoff.agentFirstName ? handoff.agentFirstName : '';
    var key = current + ':' + name;
    if (key === state.handoffKey) return;

    var wasBot = state.handoffKey === undefined || state.handoffKey.indexOf('bot:') === 0;
    if (current !== 'bot' && wasBot) state.defaultSubtitle = subtitle.textContent;
    state.handoffKey = key;
    state.agentFirstName = name;

    if (current === 'waiting') {
      subtitle.textContent = 'Connecting you to an agent…';
    } else if (current === 'active') {
      subtitle.textContent = name ? 'You are chatting with ' + name : 'You are chatting with our team';
    } else if (state.defaultSubtitle !== undefined) {
      subtitle.textContent = state.defaultSubtitle;
    }
  }

  // "Agent is typing" bubble. It lives outside the polled message list (class omni-pending).
  function setAgentTyping(isTyping) {
    var existing = messagesList.querySelector('.omni-agent-typing');
    if (isTyping && !existing) {
      var node = document.createElement('div');
      node.className = 'omni-msg-group outbound omni-pending omni-agent-typing';
      node.innerHTML = '<div class="omni-typing-indicator"><div class="omni-typing-dot"></div><div class="omni-typing-dot"></div><div class="omni-typing-dot"></div></div>';
      messagesList.appendChild(node);
      scrollToBottom();
    } else if (!isTyping && existing) {
      existing.remove();
    }
  }

  // Polling Messages
  function fetchMessages() {
    if (!state.token) return;
    apiFetch('/api/webchat/messages')
      .then(function(data) {
        applyHandoffState(data.handoff);
        setAgentTyping(Boolean(data.agentTyping));
        if (data.messages) {
          var prevCount = state.messages.length;
          renderMessages(data.messages);
          if (!state.isOpen && data.messages.length > prevCount) {
            state.unreadCount += (data.messages.length - prevCount);
            unreadBadge.textContent = state.unreadCount;
            unreadBadge.style.display = 'flex';
          }
        }
      })
      .catch(function() {});
  }

  function startPolling() {
    clearInterval(state.pollTimer);
    fetchMessages();
    state.pollTimer = setInterval(function() {
      fetchMessages();
    }, 3500);
  }

  // Background slow poll for unread badge when chat window is closed
  setInterval(function() {
    if (!state.isOpen && state.token) {
      fetchMessages();
    }
  }, 12000);

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Mount to Body
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      document.body.appendChild(hostDiv);
    });
  } else {
    document.body.appendChild(hostDiv);
  }
})();
`;
  res.send(js);
});

// ============================================================================
// 2. TENANT AUTHENTICATED WIDGET MANAGEMENT CRUD
// ============================================================================

export const webchatTenantRouter = Router();
webchatTenantRouter.use(requireAuth);

/**
 * GET /api/channels/webchat/widgets
 * List all live chat widgets for the tenant
 */
webchatTenantRouter.get(
  "/widgets",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const widgets = await listWebchatWidgets(req.auth!.tenantId);
    res.json({ widgets });
  })
);

/**
 * GET /api/channels/webchat/widgets/:id
 * Get single widget details by ID
 */
webchatTenantRouter.get(
  "/widgets/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const widget = await getWebchatWidgetById(req.auth!.tenantId, req.params.id);
    if (!widget) {
      return res.status(404).json({ error: "Webchat widget not found" });
    }
    res.json({ widget });
  })
);

/**
 * POST /api/channels/webchat/widgets
 * Create a new live chat widget and webchat channel
 */
webchatTenantRouter.post(
  "/widgets",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const {
      displayName,
      defaultFlowId,
      title,
      subtitle,
      primaryColor,
      greetingMessage,
      placeholderText,
      launcherText,
      launcherIcon,
      position,
      requireEmail,
      requireName,
      allowedOrigins,
      isActive,
      showAgentAvatar,
      offlineMessage,
      businessHours,
    } = req.body;

    const widget = await createWebchatWidget(req.auth!.tenantId, {
      displayName: displayName || title || "Website Live Chat",
      defaultFlowId,
      title,
      subtitle,
      primaryColor,
      greetingMessage,
      placeholderText,
      launcherText,
      launcherIcon,
      position,
      requireEmail,
      requireName,
      allowedOrigins,
      isActive,
      showAgentAvatar,
      offlineMessage,
      businessHours,
    });

    res.status(201).json({ widget });
  })
);

/**
 * PUT /api/channels/webchat/widgets/:id
 * Update an existing live chat widget and its settings
 */
webchatTenantRouter.put(
  "/widgets/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const {
      displayName,
      defaultFlowId,
      title,
      subtitle,
      primaryColor,
      greetingMessage,
      placeholderText,
      launcherText,
      launcherIcon,
      position,
      requireEmail,
      requireName,
      allowedOrigins,
      isActive,
      showAgentAvatar,
      offlineMessage,
      businessHours,
    } = req.body;

    const widget = await updateWebchatWidget(req.auth!.tenantId, req.params.id, {
      displayName,
      defaultFlowId,
      title,
      subtitle,
      primaryColor,
      greetingMessage,
      placeholderText,
      launcherText,
      launcherIcon,
      position,
      requireEmail,
      requireName,
      allowedOrigins,
      isActive,
      showAgentAvatar,
      offlineMessage,
      businessHours,
    });

    res.json({ widget });
  })
);

/**
 * DELETE /api/channels/webchat/widgets/:id
 * Delete a live chat widget and its associated channel
 */
webchatTenantRouter.delete(
  "/widgets/:id",
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    await deleteWebchatWidget(req.auth!.tenantId, req.params.id);
    res.json({ success: true, message: "Webchat widget deleted successfully" });
  })
);
