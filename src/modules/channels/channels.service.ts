import { query, queryOne } from "../../db/pool";
import { encryptObject, decryptObject } from "../../utils/crypto";
import { assertWithinLimit } from "../billing/plan-limits.service";
import {
  getMetaPhoneNumberDetails,
  getMetaWabaDetails,
} from "../whatsapp-onboarding/embedded-signup.service";

export interface Channel {
  id: string;
  tenant_id: string;
  type: string;
  display_name: string;
  credentials?: Record<string, any>;
  status: string;
  default_flow_id?: string | null;
  created_at: string;
  // Provider / Meta metadata fields
  verified_name?: string | null;
  display_phone_number?: string | null;
  quality_rating?: string | null;
  name_status?: string | null;
  code_verification_status?: string | null;
  bot_username?: string | null;
  bot_first_name?: string | null;
  phone_number_id?: string | null;
  waba_id?: string | null;
  messaging_limit_tier?: string | null;
  messagingLimitTier?: string | null;
}

export interface ChannelSettings {
  id: string;
  tenantId: string;
  type: string;
  displayName: string;
  status: string;
  defaultFlowId: string | null;
  createdAt: string;
  metadata: {
    // WhatsApp Meta fields
    phoneNumberId?: string;
    wabaId?: string;
    verifiedName?: string | null;
    displayPhoneNumber?: string | null;
    businessPhoneNumber?: string | null;
    qualityRating?: string | null;
    nameStatus?: string | null;
    codeVerificationStatus?: string | null;
    messagingLimitTier?: string | null;
    messaging_limit_tier?: string | null;
    wabaName?: string | null;
    timezoneId?: string | null;
    currency?: string | null;
    onboardedVia?: string | null;
    hasAccessToken?: boolean;
    maskedAccessToken?: string;
    // Telegram fields
    botUsername?: string | null;
    botFirstName?: string | null;
    botId?: string | null;
    hasBotToken?: boolean;
    maskedBotToken?: string;
    webhookSecretToken?: string | null;
  };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(id: unknown): id is string {
  return typeof id === "string" && UUID_REGEX.test(id);
}

function maskToken(token?: string | null): string {
  if (!token || typeof token !== "string") return "";
  if (token.length <= 10) return "••••••••";
  return `${token.slice(0, 6)}...••••...${token.slice(-4)}`;
}

export async function createChannel(params: {
  tenantId: string;
  type: string;
  displayName: string;
  credentials: Record<string, any>;
}): Promise<Channel> {
  const { tenantId, type, displayName, credentials } = params;
  await assertWithinLimit(tenantId, "channels");
  const encryptedCredentials = encryptObject(credentials);

  const row = await queryOne<Channel>(
    `INSERT INTO channels (tenant_id, type, display_name, credentials)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [tenantId, type, displayName, encryptedCredentials]
  );
  if (row) {
    row.credentials = decryptObject(row.credentials);
  }
  return row!;
}

export async function listChannels(tenantId: string): Promise<Channel[]> {
  const rows = await query<{
    id: string;
    tenant_id: string;
    type: string;
    display_name: string;
    credentials: any;
    status: string;
    default_flow_id: string | null;
    created_at: string;
  }>(
    `SELECT id, tenant_id, type, display_name, credentials, status, default_flow_id, created_at FROM channels
     WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId]
  );

  return rows.map((row) => {
    let creds: Record<string, any> = {};
    try {
      creds = row.credentials ? decryptObject(row.credentials) : {};
    } catch {
      creds = {};
    }

    return {
      id: row.id,
      tenant_id: row.tenant_id,
      type: row.type,
      display_name: row.display_name,
      status: row.status,
      default_flow_id: row.default_flow_id,
      created_at: row.created_at,
      verified_name: creds.verifiedName || null,
      display_phone_number: creds.displayPhoneNumber || creds.businessPhoneNumber || null,
      quality_rating: creds.qualityRating || null,
      name_status: creds.nameStatus || null,
      code_verification_status: creds.codeVerificationStatus || null,
      bot_username: creds.botUsername || null,
      bot_first_name: creds.botFirstName || null,
      phone_number_id: creds.phoneNumberId || null,
      waba_id: creds.wabaId || null,
      messaging_limit_tier: creds.messagingLimitTier || creds.messaging_limit_tier || null,
      messagingLimitTier: creds.messagingLimitTier || creds.messaging_limit_tier || null,
    };
  });
}

export async function setDefaultFlow(
  tenantId: string,
  channelId: string,
  flowId: string | null
): Promise<void> {
  if (!isValidUuid(channelId) || !isValidUuid(tenantId)) {
    throw Object.assign(new Error("Invalid channel ID or tenant ID"), { statusCode: 400 });
  }
  if (flowId) {
    if (!isValidUuid(flowId)) {
      throw Object.assign(new Error("Invalid flow ID"), { statusCode: 400 });
    }
    const flow = await queryOne<{ id: string; status: string }>(
      "SELECT id, status FROM flows WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL",
      [flowId, tenantId]
    );
    if (!flow) {
      throw Object.assign(new Error("Flow not found or deleted"), { statusCode: 404 });
    }
    if (flow.status !== "published") {
      throw Object.assign(new Error("Only published flows can be assigned to a channel. Please publish the flow first."), { statusCode: 400 });
    }
  }
  const result = await query(
    "UPDATE channels SET default_flow_id = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id",
    [flowId, channelId, tenantId]
  );
  if (result.length === 0) {
    throw Object.assign(new Error("Channel not found"), { statusCode: 404 });
  }
}

export async function getChannelWithCredentials(
  tenantId: string,
  channelId: string
): Promise<Channel | null> {
  if (!isValidUuid(channelId) || !isValidUuid(tenantId)) return null;
  const row = await queryOne<Channel>(
    "SELECT * FROM channels WHERE tenant_id = $1 AND id = $2",
    [tenantId, channelId]
  );
  if (row) {
    row.credentials = decryptObject(row.credentials);
  }
  return row;
}

export async function getChannelSettings(
  tenantId: string,
  channelId: string
): Promise<ChannelSettings | null> {
  const channel = await getChannelWithCredentials(tenantId, channelId);
  if (!channel) return null;

  const creds = channel.credentials || {};

  return {
    id: channel.id,
    tenantId: channel.tenant_id,
    type: channel.type,
    displayName: channel.display_name,
    status: channel.status,
    defaultFlowId: channel.default_flow_id || null,
    createdAt: channel.created_at,
    metadata: {
      phoneNumberId: creds.phoneNumberId,
      wabaId: creds.wabaId,
      verifiedName: creds.verifiedName || null,
      displayPhoneNumber: creds.displayPhoneNumber || creds.businessPhoneNumber || null,
      businessPhoneNumber: creds.businessPhoneNumber || null,
      qualityRating: creds.qualityRating || null,
      nameStatus: creds.nameStatus || null,
      codeVerificationStatus: creds.codeVerificationStatus || null,
      messagingLimitTier: creds.messagingLimitTier || creds.messaging_limit_tier || null,
      messaging_limit_tier: creds.messagingLimitTier || creds.messaging_limit_tier || null,
      wabaName: creds.wabaName || null,
      timezoneId: creds.timezoneId || null,
      currency: creds.currency || null,
      onboardedVia: creds.onboardedVia || null,
      hasAccessToken: Boolean(creds.accessToken),
      maskedAccessToken: maskToken(creds.accessToken),
      botUsername: creds.botUsername || null,
      botFirstName: creds.botFirstName || null,
      botId: creds.botId || null,
      hasBotToken: Boolean(creds.botToken),
      maskedBotToken: maskToken(creds.botToken),
      webhookSecretToken: creds.webhookSecretToken ? maskToken(creds.webhookSecretToken) : null,
    },
  };
}

export async function syncChannelMetadata(
  tenantId: string,
  channelId: string
): Promise<ChannelSettings | null> {
  const channel = await getChannelWithCredentials(tenantId, channelId);
  if (!channel) return null;

  const creds = { ...(channel.credentials || {}) };
  let updated = false;

  if (channel.type === "whatsapp") {
    const accessToken = creds.accessToken;
    if (accessToken) {
      if (creds.phoneNumberId) {
        const phoneDetails = await getMetaPhoneNumberDetails(creds.phoneNumberId, accessToken);
        if (phoneDetails) {
          if (phoneDetails.verified_name) creds.verifiedName = phoneDetails.verified_name;
          if (phoneDetails.display_phone_number) creds.displayPhoneNumber = phoneDetails.display_phone_number;
          if (phoneDetails.quality_rating) creds.qualityRating = phoneDetails.quality_rating;
          if (phoneDetails.name_status) creds.nameStatus = phoneDetails.name_status;
          if (phoneDetails.code_verification_status) creds.codeVerificationStatus = phoneDetails.code_verification_status;
          if (phoneDetails.messaging_limit_tier) {
            creds.messagingLimitTier = phoneDetails.messaging_limit_tier;
            creds.messaging_limit_tier = phoneDetails.messaging_limit_tier;
          }
          updated = true;
        }
      }

      if (creds.wabaId) {
        const wabaDetails = await getMetaWabaDetails(creds.wabaId, accessToken);
        if (wabaDetails) {
          if (wabaDetails.name) creds.wabaName = wabaDetails.name;
          if (wabaDetails.timezone_id) creds.timezoneId = wabaDetails.timezone_id;
          if (wabaDetails.currency) creds.currency = wabaDetails.currency;
          updated = true;
        }
      }
    }
  } else if (channel.type === "telegram") {
    const botToken = creds.botToken;
    if (botToken) {
      const baseUrl = creds.apiBaseUrl || "https://api.telegram.org";
      try {
        const res = await fetch(`${baseUrl}/bot${botToken}/getMe`);
        if (res.ok) {
          const data = (await res.json()) as { ok?: boolean; result?: { username?: string; first_name?: string; id?: number } };
          if (data?.ok && data?.result) {
            creds.botUsername = data.result.username || creds.botUsername;
            creds.botFirstName = data.result.first_name || creds.botFirstName;
            if (data.result.id) creds.botId = String(data.result.id);
            updated = true;
          }
        }
      } catch (err) {
        // Non-fatal sync error
      }
    }
  }

  if (updated) {
    await updateChannel(tenantId, channelId, { credentials: creds });
  }

  return getChannelSettings(tenantId, channelId);
}

export async function deleteChannel(
  tenantId: string,
  channelId: string
): Promise<boolean> {
  if (!isValidUuid(channelId) || !isValidUuid(tenantId)) {
    throw Object.assign(new Error("Invalid channel ID or tenant ID"), { statusCode: 400 });
  }

  const result = await query(
    "DELETE FROM channels WHERE id = $1 AND tenant_id = $2 RETURNING id",
    [channelId, tenantId]
  );
  return result.length > 0;
}

/**
 * Searches WhatsApp channels by decrypted credentials (phone number ID or WABA ID).
 * Since channel credentials are encrypted with AES-256-GCM at rest, SQL JSON operators
 * cannot query fields inside the ciphertext payload. This helper decrypts credentials
 * in-memory to accurately match incoming webhooks and embedded signup callbacks.
 */
export async function findWhatsAppChannel(identifiers: {
  phoneNumberId?: string;
  wabaId?: string;
  tenantId?: string;
}): Promise<Channel | null> {
  const { phoneNumberId, wabaId, tenantId } = identifiers;
  if (!phoneNumberId && !wabaId) return null;

  let sql = "SELECT * FROM channels WHERE type = 'whatsapp'";
  const params: any[] = [];
  if (tenantId) {
    if (!isValidUuid(tenantId)) return null;
    params.push(tenantId);
    sql += ` AND tenant_id = $${params.length}`;
  }
  sql += " ORDER BY created_at DESC";

  const rows = await query<Channel>(sql, params);
  for (const row of rows) {
    let creds: Record<string, any> = {};
    try {
      creds = row.credentials ? decryptObject(row.credentials) : {};
    } catch {
      creds = {};
    }

    if (
      phoneNumberId &&
      (creds.phoneNumberId === phoneNumberId ||
        creds.businessPhoneNumber === phoneNumberId ||
        creds.displayPhoneNumber === phoneNumberId)
    ) {
      row.credentials = creds;
      return row;
    }
    if (wabaId && creds.wabaId === wabaId) {
      row.credentials = creds;
      return row;
    }
  }

  return null;
}

/**
 * Searches Telegram channels by decrypted credentials (bot ID or username).
 */
export async function findTelegramChannel(identifiers: {
  botUsername?: string;
  botId?: string;
  tenantId?: string;
}): Promise<Channel | null> {
  const { botUsername, botId, tenantId } = identifiers;
  if (!botUsername && !botId) return null;

  let sql = "SELECT * FROM channels WHERE type = 'telegram'";
  const params: any[] = [];
  if (tenantId) {
    if (!isValidUuid(tenantId)) return null;
    params.push(tenantId);
    sql += ` AND tenant_id = $${params.length}`;
  }
  sql += " ORDER BY created_at DESC";

  const rows = await query<Channel>(sql, params);
  for (const row of rows) {
    let creds: Record<string, any> = {};
    try {
      creds = row.credentials ? decryptObject(row.credentials) : {};
    } catch {
      creds = {};
    }

    if (botId && (creds.botId === botId || creds.bot_id === botId)) {
      row.credentials = creds;
      return row;
    }
    if (botUsername && (creds.botUsername === botUsername || creds.bot_username === botUsername)) {
      row.credentials = creds;
      return row;
    }
  }

  return null;
}

/** Same tenant-agnostic-caller exception as getCampaignByIdUnscoped — see that function's comment. */
export async function getChannelByIdUnscoped(channelId: string): Promise<Channel | null> {
  if (!isValidUuid(channelId)) return null;
  const row = await queryOne<Channel>("SELECT * FROM channels WHERE id = $1", [channelId]);
  if (row) {
    row.credentials = decryptObject(row.credentials);
  }
  return row;
}

export async function updateChannel(
  tenantId: string,
  channelId: string,
  updates: { displayName?: string; credentials?: Record<string, any>; status?: string }
): Promise<Channel | null> {
  if (!isValidUuid(channelId) || !isValidUuid(tenantId)) return null;
  const encryptedCredentials = updates.credentials ? encryptObject(updates.credentials) : null;

  const row = await queryOne<Channel>(
    `UPDATE channels SET
       display_name = COALESCE($1, display_name),
       credentials  = COALESCE($2, credentials),
       status       = COALESCE($3, status)
     WHERE id = $4 AND tenant_id = $5
     RETURNING *`,
    [updates.displayName ?? null, encryptedCredentials ?? null, updates.status ?? null, channelId, tenantId]
  );
  if (row) {
    row.credentials = decryptObject(row.credentials);
  }
  return row;
}
