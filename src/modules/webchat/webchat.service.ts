import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";
import { query, queryOne, withTransaction } from "../../db/pool";
import { findOrCreateContact } from "../contacts/contacts.service";
import { findOrCreateOpenConversation } from "../conversations/conversations.service";
import { recordInboundMessage, listMessages, Message } from "../messages/messages.service";
import { runFlowForConversation } from "../flows/flow-engine-runner";
import { getChannelWithCredentials } from "../channels/channels.service";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

export interface WebchatBusinessHours {
  enabled: boolean;
  timezone: string;
  schedule: Record<
    string,
    {
      start: string; // e.g. "09:00"
      end: string;   // e.g. "18:00"
      enabled: boolean;
    }
  >;
}

export interface WebchatWidget {
  id: string;
  tenantId: string;
  channelId: string;
  widgetKey: string;
  title: string;
  subtitle: string;
  primaryColor: string;
  greetingMessage: string;
  placeholderText: string;
  launcherText: string;
  launcherIcon: string;
  position: "bottom-right" | "bottom-left";
  requireEmail: boolean;
  requireName: boolean;
  allowedOrigins: string[];
  isActive: boolean;
  showAgentAvatar: boolean;
  offlineMessage: string;
  businessHours: WebchatBusinessHours;
  createdAt: string;
  updatedAt: string;
  displayName?: string;
  channelDisplayName?: string;
  defaultFlowId?: string | null;
}

export interface VisitorAuthPayload {
  role: "visitor";
  isVisitor: true;
  tenantId: string;
  channelId: string;
  contactId: string;
  conversationId: string;
  visitorSessionId: string;
}

/**
 * Check if the business is currently online according to its configured business hours schedule.
 */
export function isBusinessOnline(businessHours?: WebchatBusinessHours): boolean {
  if (!businessHours || !businessHours.enabled) {
    return true; // If business hours are not configured or disabled, widget is always online
  }

  try {
    const tz = businessHours.timezone || "UTC";
    const now = new Date();

    // Get day name in timezone (e.g. "monday", "tuesday")
    const dayFormatter = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: tz });
    const dayOfWeek = dayFormatter.format(now).toLowerCase();

    // Get current time in HH:mm
    const timeFormatter = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    });
    const currentTime = timeFormatter.format(now);

    const daySchedule = businessHours.schedule?.[dayOfWeek];
    if (!daySchedule || !daySchedule.enabled) {
      return false;
    }

    const { start, end } = daySchedule;
    if (!start || !end) return true;

    return currentTime >= start && currentTime <= end;
  } catch {
    return true;
  }
}

/**
 * Helper to extract a normalized, lowercase hostname without protocol, port, paths, trailing slashes, or wildcards.
 */
export function extractCleanHostname(input: string): string {
  if (!input || typeof input !== "string") return "";
  let str = input.trim().toLowerCase();
  str = str.replace(/^\*\./, "");
  if (str.startsWith("http://") || str.startsWith("https://")) {
    try {
      return new URL(str).hostname.toLowerCase();
    } catch {}
  }
  str = str.replace(/^https?:\/\//, "");
  str = str.split("/")[0].split("?")[0].split("#")[0];
  str = str.split(":")[0].trim();
  return str;
}

/**
 * Safely validate whether an incoming HTTP Origin or Referer header is allowed by the widget's allowedOrigins list.
 * Permissive rules:
 * 1. If allowedOrigins is not defined, empty ([]), or contains wildcard "*", allow all origins.
 * 2. If originHeader is missing (e.g. direct browser visit or same-origin call), allow.
 * 3. Always allow localhost, 127.0.0.1, IPv6 loopback, and local tunnel hosts (ngrok, localtunnel).
 * 4. Match domain or subdomains (e.g. "example.com" matches "example.com" and "app.example.com", or "*.example.com").
 */
export function isOriginAllowed(allowedOrigins?: string[] | null, originHeader?: string): boolean {
  if (!allowedOrigins || allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
    return true;
  }

  if (!originHeader || typeof originHeader !== "string" || originHeader.trim() === "") {
    return true;
  }

  const originHostname = extractCleanHostname(originHeader);
  if (!originHostname) return true;

  // Local development / testing origins are always permitted
  if (
    originHostname === "localhost" ||
    originHostname === "127.0.0.1" ||
    originHostname === "::1" ||
    originHostname.endsWith(".ngrok-free.app") ||
    originHostname.endsWith(".ngrok.io") ||
    originHostname.endsWith(".loca.lt")
  ) {
    return true;
  }

  return allowedOrigins.some((allowed) => {
    if (!allowed || typeof allowed !== "string") return false;
    const trimmed = allowed.trim();
    if (trimmed === "*" || trimmed === "") return true;

    const allowedHostname = extractCleanHostname(trimmed);
    if (!allowedHostname) return false;

    return originHostname === allowedHostname || originHostname.endsWith(`.${allowedHostname}`);
  });
}

/**
 * Map PostgreSQL database row to WebchatWidget interface
 */
function mapRowToWidget(row: any): WebchatWidget {
  let schedule = row.business_hours;
  if (typeof schedule === "string") {
    try {
      schedule = JSON.parse(schedule);
    } catch {
      schedule = { enabled: false, timezone: "UTC", schedule: {} };
    }
  }

  return {
    id: row.id,
    tenantId: row.tenant_id,
    channelId: row.channel_id,
    widgetKey: row.widget_key,
    title: row.title || "Chat with us",
    subtitle: row.subtitle || "We usually reply in minutes",
    primaryColor: row.primary_color || "#2563eb",
    greetingMessage: row.greeting_message || "Hello! How can we help you today?",
    placeholderText: row.placeholder_text || "Type your message...",
    launcherText: row.launcher_text || "Chat with us",
    launcherIcon: row.launcher_icon || "chat",
    position: row.position || "bottom-right",
    requireEmail: Boolean(row.require_email),
    requireName: Boolean(row.require_name),
    allowedOrigins:
      Array.isArray(row.allowed_origins) && row.allowed_origins.length > 0
        ? row.allowed_origins
        : ["*"],
    isActive: Boolean(row.is_active),
    showAgentAvatar: Boolean(row.show_agent_avatar),
    offlineMessage:
      row.offline_message ||
      "We are currently offline. Please leave your message and email and we will get back to you.",
    businessHours: schedule || { enabled: false, timezone: "UTC", schedule: {} },
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
    displayName: row.channel_display_name || row.title || "Website Live Chat",
    channelDisplayName: row.channel_display_name,
    defaultFlowId: row.default_flow_id || null,
  };
}

/**
 * List all Webchat widgets for a tenant
 */
export async function listWebchatWidgets(tenantId: string): Promise<WebchatWidget[]> {
  const rows = await query<any>(
    `SELECT w.*, c.display_name AS channel_display_name, c.default_flow_id
     FROM webchat_widgets w
     JOIN channels c ON c.id = w.channel_id
     WHERE w.tenant_id = $1
     ORDER BY w.created_at DESC`,
    [tenantId]
  );
  return rows.map(mapRowToWidget);
}

/**
 * Get a specific Webchat widget by its ID
 */
export async function getWebchatWidgetById(tenantId: string, widgetId: string): Promise<WebchatWidget | null> {
  const row = await queryOne<any>(
    `SELECT w.*, c.display_name AS channel_display_name, c.default_flow_id
     FROM webchat_widgets w
     JOIN channels c ON c.id = w.channel_id
     WHERE w.id = $1 AND w.tenant_id = $2`,
    [widgetId, tenantId]
  );
  return row ? mapRowToWidget(row) : null;
}

/**
 * Get Webchat widget associated with a given Channel ID
 */
export async function getWebchatWidgetByChannelId(tenantId: string, channelId: string): Promise<WebchatWidget | null> {
  const row = await queryOne<any>(
    `SELECT w.*, c.display_name AS channel_display_name, c.default_flow_id
     FROM webchat_widgets w
     JOIN channels c ON c.id = w.channel_id
     WHERE w.channel_id = $1 AND w.tenant_id = $2`,
    [channelId, tenantId]
  );
  return row ? mapRowToWidget(row) : null;
}

/**
 * Create a new Webchat Channel and its associated customizable Widget
 */
export async function createWebchatWidget(
  tenantId: string,
  params: {
    displayName: string;
    defaultFlowId?: string | null;
    title?: string;
    subtitle?: string;
    primaryColor?: string;
    greetingMessage?: string;
    placeholderText?: string;
    launcherText?: string;
    launcherIcon?: string;
    position?: "bottom-right" | "bottom-left";
    requireEmail?: boolean;
    requireName?: boolean;
    allowedOrigins?: string[];
    isActive?: boolean;
    showAgentAvatar?: boolean;
    offlineMessage?: string;
    businessHours?: WebchatBusinessHours;
  }
): Promise<WebchatWidget> {
  return withTransaction(async (client) => {
    // 1. Create Channel row with type 'webchat'
    const channelRes = await client.query(
      `INSERT INTO channels (tenant_id, type, display_name, default_flow_id, status, credentials)
       VALUES ($1, 'webchat', $2, $3, 'connected', '{}')
       RETURNING *`,
      [tenantId, params.displayName || "Website Live Chat", params.defaultFlowId || null]
    );
    const channel = channelRes.rows[0];

    // 2. Generate unique widget key
    const widgetKey = `wc_${crypto.randomBytes(12).toString("hex")}`;

    // 3. Create webchat_widgets row
    const widgetRes = await client.query(
      `INSERT INTO webchat_widgets (
         tenant_id, channel_id, widget_key, title, subtitle, primary_color,
         greeting_message, placeholder_text, launcher_text, launcher_icon,
         position, require_email, require_name, allowed_origins, is_active,
         show_agent_avatar, offline_message, business_hours
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING *`,
      [
        tenantId,
        channel.id,
        widgetKey,
        params.title || "Chat with us",
        params.subtitle || "We usually reply in minutes",
        params.primaryColor || "#2563eb",
        params.greetingMessage || "Hello! How can we help you today?",
        params.placeholderText || "Type your message...",
        params.launcherText || "Chat with us",
        params.launcherIcon || "chat",
        params.position || "bottom-right",
        Boolean(params.requireEmail),
        Boolean(params.requireName),
        params.allowedOrigins || ["*"],
        params.isActive !== false,
        params.showAgentAvatar !== false,
        params.offlineMessage ||
          "We are currently offline. Please leave your message and email and we will get back to you.",
        JSON.stringify(params.businessHours || { enabled: false, timezone: "UTC", schedule: {} }),
      ]
    );

    const widgetRow = widgetRes.rows[0];
    widgetRow.channel_display_name = channel.display_name;
    widgetRow.default_flow_id = channel.default_flow_id;

    return mapRowToWidget(widgetRow);
  });
}

/**
 * Update an existing Webchat Widget
 */
export async function updateWebchatWidget(
  tenantId: string,
  widgetId: string,
  params: {
    displayName?: string;
    defaultFlowId?: string | null;
    title?: string;
    subtitle?: string;
    primaryColor?: string;
    greetingMessage?: string;
    placeholderText?: string;
    launcherText?: string;
    launcherIcon?: string;
    position?: "bottom-right" | "bottom-left";
    requireEmail?: boolean;
    requireName?: boolean;
    allowedOrigins?: string[];
    isActive?: boolean;
    showAgentAvatar?: boolean;
    offlineMessage?: string;
    businessHours?: WebchatBusinessHours;
  }
): Promise<WebchatWidget> {
  const existing = await getWebchatWidgetById(tenantId, widgetId);
  if (!existing) {
    throw Object.assign(new Error("Webchat widget not found"), { statusCode: 404 });
  }

  return withTransaction(async (client) => {
    // 1. Update channel if displayName or defaultFlowId changed
    if (params.displayName !== undefined || params.defaultFlowId !== undefined) {
      const updates: string[] = [];
      const values: any[] = [];
      let idx = 1;

      if (params.displayName !== undefined) {
        updates.push(`display_name = $${idx++}`);
        values.push(params.displayName);
      }
      if (params.defaultFlowId !== undefined) {
        updates.push(`default_flow_id = $${idx++}`);
        values.push(params.defaultFlowId);
      }

      if (updates.length > 0) {
        values.push(existing.channelId);
        values.push(tenantId);
        await client.query(
          `UPDATE channels SET ${updates.join(", ")} WHERE id = $${idx++} AND tenant_id = $${idx++}`,
          values
        );
      }
    }

    // 2. Update widget settings
    const widgetRes = await client.query(
      `UPDATE webchat_widgets
       SET title = COALESCE($1, title),
           subtitle = COALESCE($2, subtitle),
           primary_color = COALESCE($3, primary_color),
           greeting_message = COALESCE($4, greeting_message),
           placeholder_text = COALESCE($5, placeholder_text),
           launcher_text = COALESCE($6, launcher_text),
           launcher_icon = COALESCE($7, launcher_icon),
           position = COALESCE($8, position),
           require_email = COALESCE($9, require_email),
           require_name = COALESCE($10, require_name),
           allowed_origins = COALESCE($11, allowed_origins),
           is_active = COALESCE($12, is_active),
           show_agent_avatar = COALESCE($13, show_agent_avatar),
           offline_message = COALESCE($14, offline_message),
           business_hours = COALESCE($15, business_hours),
           updated_at = now()
       WHERE id = $16 AND tenant_id = $17
       RETURNING *`,
      [
        params.title,
        params.subtitle,
        params.primaryColor,
        params.greetingMessage,
        params.placeholderText,
        params.launcherText,
        params.launcherIcon,
        params.position,
        params.requireEmail,
        params.requireName,
        params.allowedOrigins,
        params.isActive,
        params.showAgentAvatar,
        params.offlineMessage,
        params.businessHours ? JSON.stringify(params.businessHours) : null,
        widgetId,
        tenantId,
      ]
    );

    const updatedRow = widgetRes.rows[0];
    const channelRow = await client.query("SELECT display_name, default_flow_id FROM channels WHERE id = $1", [
      existing.channelId,
    ]);
    updatedRow.channel_display_name = channelRow.rows[0]?.display_name;
    updatedRow.default_flow_id = channelRow.rows[0]?.default_flow_id;

    return mapRowToWidget(updatedRow);
  });
}

/**
 * Delete a Webchat Widget and its Channel
 */
export async function deleteWebchatWidget(tenantId: string, widgetId: string): Promise<void> {
  const widget = await getWebchatWidgetById(tenantId, widgetId);
  if (!widget) {
    throw Object.assign(new Error("Webchat widget not found"), { statusCode: 404 });
  }

  // Deleting the channel cascades to webchat_widgets via FK ON DELETE CASCADE
  await query("DELETE FROM channels WHERE id = $1 AND tenant_id = $2", [widget.channelId, tenantId]);
}

/**
 * PUBLIC VISITOR: Get public widget configuration by widget key
 */
export async function getPublicWidgetConfig(
  widgetKey: string,
  originHeader?: string
): Promise<{
  widgetKey: string;
  title: string;
  subtitle: string;
  primaryColor: string;
  greetingMessage: string;
  placeholderText: string;
  launcherText: string;
  launcherIcon: string;
  position: "bottom-right" | "bottom-left";
  requireEmail: boolean;
  requireName: boolean;
  isActive: boolean;
  showAgentAvatar: boolean;
  offlineMessage: string;
  isOnline: boolean;
  allowedOrigins: string[];
}> {
  const row = await queryOne<any>(
    `SELECT w.*
     FROM webchat_widgets w
     WHERE w.widget_key = $1`,
    [widgetKey]
  );

  if (!row) {
    throw Object.assign(new Error("Widget not found or inactive"), { statusCode: 404 });
  }

  const widget = mapRowToWidget(row);

  // Check allowed origins if specified
  if (!isOriginAllowed(widget.allowedOrigins, originHeader)) {
    throw Object.assign(new Error("Origin not allowed for this webchat widget"), { statusCode: 403 });
  }

  const isOnline = isBusinessOnline(widget.businessHours);

  return {
    widgetKey: widget.widgetKey,
    title: widget.title,
    subtitle: widget.subtitle,
    primaryColor: widget.primaryColor,
    greetingMessage: widget.greetingMessage,
    placeholderText: widget.placeholderText,
    launcherText: widget.launcherText,
    launcherIcon: widget.launcherIcon,
    position: widget.position,
    requireEmail: widget.requireEmail,
    requireName: widget.requireName,
    isActive: widget.isActive,
    showAgentAvatar: widget.showAgentAvatar,
    offlineMessage: widget.offlineMessage,
    isOnline,
    allowedOrigins: widget.allowedOrigins,
  };
}

/**
 * PUBLIC VISITOR: Initialize or resume a stateless visitor session
 */
export async function initVisitorSession(params: {
  widgetKey: string;
  visitorSessionId?: string;
  contactName?: string;
  contactEmail?: string;
  metadata?: Record<string, any>;
  originHeader?: string;
}): Promise<{
  token: string;
  visitorSessionId: string;
  conversationId: string;
  contactId: string;
  contactName: string;
  isOnline: boolean;
  greetingMessage: string;
  offlineMessage: string;
  messages: Message[];
}> {
  const { widgetKey, contactName, contactEmail, metadata = {}, originHeader } = params;

  const row = await queryOne<any>(
    `SELECT w.*, c.tenant_id, c.id as channel_id, c.status as channel_status
     FROM webchat_widgets w
     JOIN channels c ON c.id = w.channel_id
     WHERE w.widget_key = $1`,
    [widgetKey]
  );

  if (!row) {
    throw Object.assign(new Error("Webchat widget not found"), { statusCode: 404 });
  }

  if (!row.is_active) {
    throw Object.assign(new Error("Webchat widget is currently disabled"), { statusCode: 403 });
  }

  const widget = mapRowToWidget(row);

  // Check allowed origins if specified
  if (!isOriginAllowed(widget.allowedOrigins, originHeader)) {
    throw Object.assign(new Error("Origin not allowed for this webchat widget"), { statusCode: 403 });
  }

  const tenantId = row.tenant_id;
  const channelId = row.channel_id;

  // Determine visitor identifier
  const visitorSessionId =
    params.visitorSessionId && params.visitorSessionId.trim()
      ? params.visitorSessionId.trim()
      : `guest_${uuidv4().replace(/-/g, "")}`;

  // Find or create Contact
  const contact = await findOrCreateContact({
    tenantId,
    channelId,
    externalId: visitorSessionId,
    name: contactName || "Website Visitor",
    attributes: {
      email: contactEmail || undefined,
      isWebchatVisitor: true,
      lastSeenAt: new Date().toISOString(),
      ...metadata,
    },
  });

  // If new name or email was provided on an existing contact, update it
  if ((contactName && contact.name !== contactName) || (contactEmail && contact.attributes?.email !== contactEmail)) {
    const updatedName = contactName || contact.name;
    const updatedAttributes = {
      ...contact.attributes,
      ...(contactEmail ? { email: contactEmail } : {}),
      lastSeenAt: new Date().toISOString(),
      ...metadata,
    };
    await query(
      "UPDATE contacts SET name = $1, attributes = $2, updated_at = now() WHERE id = $3 AND tenant_id = $4",
      [updatedName, JSON.stringify(updatedAttributes), contact.id, tenantId]
    );
  }

  // Find or create Conversation
  const conversation = await findOrCreateOpenConversation({
    tenantId,
    contactId: contact.id,
    channelId,
    reuseClosed: true, // the visitor's first message reopens their closed case
  });

  // Issue 30-day signed visitor JWT token
  const tokenPayload: VisitorAuthPayload = {
    role: "visitor",
    isVisitor: true,
    tenantId,
    channelId,
    contactId: contact.id,
    conversationId: conversation.id,
    visitorSessionId: contact.external_id,
  };

  const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: "30d" });

  // Fetch recent conversation history (gracefully handle empty or MongoDB connect retry)
  let messages: any[] = [];
  try {
    messages = await listMessages(tenantId, conversation.id);
  } catch (err: any) {
    console.error("[webchat] Failed to fetch previous conversation messages from MongoDB (non-fatal):", err?.message);
    messages = [];
  }
  const isOnline = isBusinessOnline(widget.businessHours);

  return {
    token,
    visitorSessionId: contact.external_id,
    conversationId: conversation.id,
    contactId: contact.id,
    contactName: contact.name || "Website Visitor",
    isOnline,
    greetingMessage: widget.greetingMessage,
    offlineMessage: widget.offlineMessage,
    messages,
  };
}

/**
 * PUBLIC VISITOR: Send an inbound visitor message and trigger visual flow bots / AI Copilot
 */
export async function sendVisitorMessage(params: {
  tenantId: string;
  channelId: string;
  conversationId: string;
  contactId: string;
  visitorSessionId: string;
  text?: string;
  mediaStorageKey?: string;
  filename?: string;
  type?: string;
}): Promise<Message> {
  const { tenantId, channelId, conversationId, visitorSessionId, text, mediaStorageKey, filename } = params;

  if (!text && !mediaStorageKey) {
    throw Object.assign(new Error("Message text or media is required"), { statusCode: 400 });
  }

  const messageType = mediaStorageKey ? params.type || "document" : "text";
  const providerMessageId = `wc_in_${uuidv4()}`;

  const { message } = await recordInboundMessage({
    tenantId,
    conversationId,
    type: messageType,
    content: {
      text,
      mediaStorageKey,
      filename,
      visitorSessionId,
    },
    sentAt: new Date(),
    providerMessageId,
  });

  // Trigger visual flow builder state machine or AI Copilot for this conversation
  const channel = await getChannelWithCredentials(tenantId, channelId).catch(() => null);
  runFlowForConversation({
    tenantId,
    conversationId,
    defaultFlowId: channel?.default_flow_id || null,
    incomingText: text,
  }).catch((err) => {
    console.error("[webchat] Flow engine execution error (non-fatal):", err);
  });

  return message;
}
