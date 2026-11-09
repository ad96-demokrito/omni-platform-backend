import { v4 as uuidv4 } from "uuid";
import { getMongoDb } from "../../db/mongo";
import { query, queryOne } from "../../db/pool";
import {
  touchLastMessageAt,
  touchLastInboundAt,
  getConversation,
  claimOnHumanReply,
  pauseBotForConversation,
  reopenOnCustomerMessage,
} from "../conversations/conversations.service";
import { getChannelWithCredentials } from "../channels/channels.service";
import { getAdapter } from "../channels/channel-registry";
import { resolveHeaderMediaUrl } from "../../db/object-storage";
import {
  isSafeMediaKey,
  keyFromMediaUrl,
  providerMediaUrl,
  signedMediaUrl,
  tenantOwnsKey,
} from "../media/media.service";
import { isUuid } from "../../utils/http-error";
import { indexMessage } from "../search/search.service";
import { emitRealtimeEvent } from "../realtime/websocket.service";
import { dispatchWebhookEvent } from "../webhooks/outgoing-webhooks.service";

/**
 * Messages live in MongoDB, not Postgres — per architecture doc §3, chat
 * logs are high write volume with semi-structured payloads that vary per
 * channel, which is exactly the shape Mongo is suited for. Everything else
 * (tenants, contacts, conversations) stays relational in Postgres;
 * conversationId/tenantId here are just plain string fields, not enforced
 * foreign keys — Mongo doesn't have those, so referential integrity for
 * messages is the app's responsibility, not the database's.
 */
export interface Message {
  _id?: string;
  id: string;
  tenant_id: string;
  tenantId?: string;
  conversation_id: string;
  conversationId?: string;
  direction: "inbound" | "outbound";
  type: string;
  text?: string;
  mediaUrl?: string;
  mediaStorageKey?: string;
  content: Record<string, any>;
  sender_user_id: string | null;
  senderUserId?: string | null;
  senderType?: "customer" | "agent" | "bot" | "system";
  sent_at: string;
  sentAt?: string;
  createdAt?: string;
  created_at?: string;
  provider_message_id?: string;
  providerMessageId?: string;
  status?: "received" | "sent" | "delivered" | "read" | "failed";
  errorCode?: string;
  errorMessage?: string;
  error_code?: string;
  error_message?: string;
}

interface MessageDoc {
  id: string;
  tenantId: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  type: string;
  content: Record<string, any>;
  senderUserId: string | null;
  sentAt: Date;
  providerMessageId?: string;
  latestStatus?: "sent" | "delivered" | "read" | "failed";
  latestStatusAt?: Date;
  errorCode?: string;
  errorMessage?: string;
}

interface MessageStatusEventDoc {
  id: string;
  tenantId: string;
  messageId: string;
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  errorCode?: string;
  errorMessage?: string;
  timestamp: Date;
}

function toMessage(doc: MessageDoc): Message {
  // Older webchat uploads were saved with type "file"; every consumer understands "document".
  const type = doc.type === "file" ? "document" : doc.type;
  const rawText = doc.content?.text || (typeof doc.content === "string" ? doc.content : "");
  const text =
    rawText ||
    (type === "template" ? `[Template: ${doc.content?.templateName || ""}]` : "") ||
    (type === "image" ? "[Image]" : "") ||
    (type === "document" ? (doc.content?.filename ? `[Document: ${doc.content.filename}]` : "[Document]") : "") ||
    (type === "audio" ? "[Audio]" : "") ||
    (type === "video" ? "[Video]" : "") ||
    (type === "sticker" ? "[Sticker]" : "") ||
    "";

  const isoDate = doc.sentAt ? new Date(doc.sentAt).toISOString() : new Date().toISOString();
  const storedUrl = doc.content?.headerValue || doc.content?.mediaUrl || doc.content?.mediaProviderId;
  // Old rows only kept a /api/media/file?key= URL, so recover the key from it.
  const mediaStorageKey: string | undefined = doc.content?.mediaStorageKey || keyFromMediaUrl(storedUrl);
  // The stored URL may have expired (presigned) or be relative to the wrong origin, so a file we hold
  // is always re-linked with a fresh signed URL.
  const mediaUrl = mediaStorageKey ? signedMediaUrl(mediaStorageKey) : storedUrl;

  return {
    _id: doc.id,
    id: doc.id,
    tenant_id: doc.tenantId,
    tenantId: doc.tenantId,
    conversation_id: doc.conversationId,
    conversationId: doc.conversationId,
    direction: doc.direction,
    type,
    text,
    mediaUrl,
    mediaStorageKey,
    content: doc.content,
    sender_user_id: doc.senderUserId,
    senderUserId: doc.senderUserId,
    senderType: doc.direction === "inbound" ? "customer" : (doc.senderUserId ? "agent" : "bot"),
    sent_at: isoDate,
    sentAt: isoDate,
    createdAt: isoDate,
    created_at: isoDate,
    provider_message_id: doc.providerMessageId,
    providerMessageId: doc.providerMessageId,
    status: doc.latestStatus || (doc.direction === "inbound" ? "received" : "sent"),
    errorCode: doc.errorCode,
    errorMessage: doc.errorMessage,
    error_code: doc.errorCode,
    error_message: doc.errorMessage,
  };
}

async function getMessagesCollection() {
  const db = await getMongoDb();
  const collection = db.collection<MessageDoc>("messages");
  // Cheap to call repeatedly — MongoDB no-ops if the index already exists.
  await collection.createIndex({ conversationId: 1, sentAt: 1 });
  await collection.createIndex({ tenantId: 1 });
  await collection.createIndex({ providerMessageId: 1 });
  return collection;
}

async function getMessageStatusEventsCollection() {
  const db = await getMongoDb();
  const collection = db.collection<MessageStatusEventDoc>("message_status_events");
  await collection.createIndex({ providerMessageId: 1 });
  await collection.createIndex({ messageId: 1 });
  await collection.createIndex({ tenantId: 1, timestamp: -1 });
  return collection;
}

export async function recordInboundMessage(params: {
  tenantId: string;
  conversationId: string;
  type: string;
  content: Record<string, any>;
  sentAt: Date;
  providerMessageId?: string;
}): Promise<{ message: Message; isDuplicate: boolean }> {
  const { tenantId, conversationId, type, content, sentAt, providerMessageId } = params;
  const collection = await getMessagesCollection();

  // Deduplication check: if this provider message was already stored, return the existing message
  if (providerMessageId) {
    const existing = await collection.findOne({ providerMessageId });
    if (existing) {
      return { message: toMessage(existing), isDuplicate: true };
    }
  }

  const doc: MessageDoc = {
    id: uuidv4(),
    tenantId,
    conversationId,
    direction: "inbound",
    type,
    content,
    senderUserId: null,
    sentAt,
    providerMessageId,
  };
  await collection.insertOne(doc);
  await touchLastInboundAt(conversationId, sentAt);
  // A new (non-duplicate) customer message reopens a closed case; the message is already saved,
  // so a failure here must not lose it.
  await reopenOnCustomerMessage(tenantId, conversationId).catch((err) => {
    console.error("[messages] Could not reopen closed conversation (non-fatal):", err?.message);
  });
  const message = toMessage(doc);
  emitRealtimeEvent(tenantId, "message:new", message, { conversationId }).catch((err) => {
    console.error("[messages] Realtime event emit failed (non-fatal):", err);
  });
  getConversation(tenantId, conversationId)
    .then((updatedConv) => {
      if (updatedConv) {
        emitRealtimeEvent(tenantId, "conversation:update", updatedConv, { conversationId }).catch(() => {});
      }
    })
    .catch(() => {});
  dispatchWebhookEvent(tenantId, "message.received", message).catch((err) => {
    console.error("[messages] Webhook dispatch failed (non-fatal):", err);
  });
  indexMessage(message).catch((err) => {
    // Search indexing is best-effort — a search-index outage should never
    // block message delivery. See src/modules/search/search.service.ts.
    console.error("[messages] Elasticsearch indexing failed (non-fatal):", err);
  });
  return { message, isDuplicate: false };
}

/**
 * Sends a message from an agent (or, later, the flow engine) out through
 * whichever channel the conversation belongs to, then records it.
 */
export async function sendOutboundMessage(params: {
  tenantId: string;
  conversationId: string;
  senderUserId?: string;
  text?: string;
  type?: "text" | "template" | "image" | "document" | "audio" | "video" | "sticker";
  mediaUrl?: string;
  mediaStorageKey?: string;
  filename?: string;
  templateName?: string;
  templateLanguage?: string;
  templateParams?: Record<string, string>;
  headerType?: "TEXT" | "IMAGE" | "DOCUMENT" | "VIDEO";
  headerValue?: string;
}): Promise<Message> {
  const {
    tenantId,
    conversationId,
    senderUserId,
    text,
    type = "text",
    filename,
    templateName,
    templateLanguage,
    templateParams,
    headerType,
    headerValue,
  } = params;
  let { mediaUrl, mediaStorageKey } = params;

  // The key comes from the client; it must point at one of this tenant's own files.
  if (mediaStorageKey && !(isSafeMediaKey(mediaStorageKey) && tenantOwnsKey(tenantId, mediaStorageKey))) {
    throw Object.assign(new Error("Invalid media reference"), { status: 400 });
  }

  const conversation = await queryOne<{ channel_id: string; contact_external_id: string }>(
    `SELECT c.channel_id, ct.external_id AS contact_external_id
     FROM conversations c
     JOIN contacts ct ON ct.id = c.contact_id
     WHERE c.id = $1 AND c.tenant_id = $2`,
    [conversationId, tenantId]
  );
  if (!conversation) throw new Error("Conversation not found");

  const channel = await getChannelWithCredentials(tenantId, conversation.channel_id);
  if (!channel) throw new Error("Channel not found");

  const adapter = getAdapter(channel.type);

  let providerMessageId: string | undefined;

  if (type === "template") {
    // Send WhatsApp template message
    if (!templateName) throw new Error("templateName is required for template messages");
    const resolvedHeaderValue = await resolveHeaderMediaUrl(mediaStorageKey, headerValue);
    const result = await adapter.send(
      {
        toExternalContactId: conversation.contact_external_id,
        type: "template",
        templateName,
        templateLanguage,
        templateParams,
        headerType,
        headerValue: resolvedHeaderValue,
        filename,
      },
      channel.credentials || {}
    );
    providerMessageId = result.providerMessageId;
  } else if (["image", "document", "audio", "video", "sticker"].includes(type)) {
    // Media message sending
    if (!mediaUrl && mediaStorageKey) {
      mediaUrl = await providerMediaUrl(mediaStorageKey);
    }
    if (!mediaUrl) throw new Error(`mediaUrl or mediaStorageKey is required for ${type} messages`);

    const result = await adapter.send(
      {
        toExternalContactId: conversation.contact_external_id,
        type: type as any,
        text,
        mediaUrl,
        filename,
      },
      channel.credentials || {}
    );
    providerMessageId = result.providerMessageId;
  } else {
    // Send plain text message
    if (!text) throw new Error("text is required for text messages");
    const result = await adapter.send(
      { toExternalContactId: conversation.contact_external_id, type: "text", text },
      channel.credentials || {}
    );
    providerMessageId = result.providerMessageId;
  }

  let content: Record<string, any>;
  if (type === "template") {
    content = {
      templateName,
      templateLanguage,
      templateParams,
      headerType,
      // Stored with the message for the inbox preview, so it must not be a URL that expires.
      headerValue: mediaStorageKey ? `/api/media/file?key=${encodeURIComponent(mediaStorageKey)}` : headerValue,
      mediaStorageKey,
      filename,
    };
  } else if (type === "text") {
    content = { text };
  } else {
    // With a storage key the URL is generated on read (toMessage); a stored one would only go stale.
    content = mediaStorageKey ? { text, mediaStorageKey, filename } : { text, mediaUrl, filename };
  }

  const doc: MessageDoc = {
    id: uuidv4(),
    tenantId,
    conversationId,
    direction: "outbound",
    type,
    content,
    senderUserId: senderUserId || null,
    sentAt: new Date(),
    providerMessageId,
    latestStatus: "sent",
    latestStatusAt: new Date(),
  };
  const collection = await getMessagesCollection();
  await collection.insertOne(doc);
  await touchLastMessageAt(conversationId);

  if (senderUserId) {
    // When a human agent sends a message from the inbox the bot steps aside, so automated flows
    // don't collide with the agent (also when no flow run is active at this moment).
    await pauseBotForConversation(tenantId, conversationId).catch((err) => {
      console.error("[messages] Could not pause the bot after an agent reply (non-fatal):", err?.message);
    });

    // The agent who replies owns an unassigned case, and a pending case becomes open.
    await claimOnHumanReply(tenantId, conversationId, senderUserId).catch((err) => {
      console.error("[messages] Could not assign conversation to the replying agent (non-fatal):", err?.message);
    });
  }

  // SLA: the first response is the first reply from a person. Bot and flow messages have no sender
  // user, so they no longer count; API-key senders are programmatic and do not count either.
  if (senderUserId && isUuid(senderUserId)) {
    try {
      await query(
        `UPDATE conversations
         SET first_response_at = COALESCE(first_response_at, now()),
             first_response_duration_seconds = COALESCE(first_response_duration_seconds, EXTRACT(EPOCH FROM (now() - created_at))::INTEGER)
         WHERE id = $1 AND tenant_id = $2 AND first_response_at IS NULL`,
        [conversationId, tenantId]
      );
    } catch (err: any) {
      console.error("[messages] Failed to update conversation SLA first response metrics (non-fatal):", err?.message);
    }
  }

  const message = toMessage(doc);
  emitRealtimeEvent(tenantId, "message:new", message, { conversationId }).catch((err) => {
    console.error("[messages] Realtime event emit failed (non-fatal):", err);
  });
  dispatchWebhookEvent(tenantId, "message.sent", message).catch((err) => {
    console.error("[messages] Webhook dispatch failed (non-fatal):", err);
  });
  indexMessage(message).catch((err) => {
    console.error("[messages] Elasticsearch indexing failed (non-fatal):", err);
  });
  return message;
}

export async function listMessages(tenantId: string, conversationId: string): Promise<Message[]> {
  const collection = await getMessagesCollection();
  const docs = await collection
    .find({ tenantId, conversationId })
    .sort({ sentAt: 1 })
    .toArray();
  return docs.map(toMessage);
}

export async function findMessageByProviderId(
  providerMessageId: string
): Promise<{ message: Message; tenantId: string; conversationId: string } | null> {
  const collection = await getMessagesCollection();
  const doc = await collection.findOne({ providerMessageId });
  if (!doc) return null;
  return {
    message: toMessage(doc),
    tenantId: doc.tenantId,
    conversationId: doc.conversationId,
  };
}

export async function recordMessageStatusEvent(params: {
  tenantId: string;
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  errorCode?: string;
  errorMessage?: string;
  timestamp: Date;
}): Promise<{ conversationId?: string }> {
  const { tenantId, providerMessageId, status, errorCode, errorMessage, timestamp } = params;

  const messagesCol = await getMessagesCollection();
  const messageDoc = await messagesCol.findOne({ providerMessageId });

  // Record status event in audit collection
  const statusEventsCol = await getMessageStatusEventsCollection();
  await statusEventsCol.insertOne({
    id: uuidv4(),
    tenantId,
    messageId: messageDoc?.id || "unknown",
    providerMessageId,
    status,
    errorCode,
    errorMessage,
    timestamp,
  });

  // Update latest status on the message doc
  if (messageDoc) {
    const updateFields: Record<string, any> = {
      latestStatus: status,
      latestStatusAt: timestamp,
    };
    if (errorCode !== undefined) updateFields.errorCode = errorCode;
    if (errorMessage !== undefined) updateFields.errorMessage = errorMessage;

    await messagesCol.updateOne(
      { id: messageDoc.id },
      { $set: updateFields }
    );
    emitRealtimeEvent(
      tenantId,
      "message:status",
      {
        id: messageDoc.id,
        messageId: messageDoc.id,
        providerMessageId,
        status,
        errorCode,
        errorMessage,
        error_code: errorCode,
        error_message: errorMessage,
        timestamp: timestamp.toISOString(),
      },
      { conversationId: messageDoc.conversationId }
    ).catch(() => {});
    return { conversationId: messageDoc.conversationId };
  }

  return {};
}
