import crypto from "crypto";
import {
  ChannelAdapter,
  NormalizedMessage,
  OutboundCarouselCard,
  OutboundMessage,
  MessageStatusUpdate,
} from "./channel-adapter.interface";

/**
 * WhatsApp adapter, written against the Meta Cloud API webhook shape (most
 * BSPs — Gupshup, 360dialog, etc. — either pass this shape through directly
 * or something very close to it). The `send()` method's endpoint/auth will
 * need a small tweak per BSP once one is chosen; the parsing/verification
 * logic below is provider-agnostic Meta Cloud API format.
 */
export class WhatsAppAdapter implements ChannelAdapter {
  readonly type = "whatsapp" as const;

  verifyWebhookSignature(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    credentials: { appSecret?: string }
  ): boolean {
    const signatureHeader = headers["x-hub-signature-256"];
    if (!signatureHeader || typeof signatureHeader !== "string") return false;

    // Real Tech Provider case: Meta signs every webhook with YOUR platform's
    // single app secret, not a per-tenant one — one Meta app receives
    // webhooks for every onboarded WABA (see completeEmbeddedSignup, which
    // stores wabaId/phoneNumberId/accessToken but no appSecret). Falling
    // back to credentials.appSecret only matters for manually-created
    // channels (tests, or a future BSP path with its own signing secret).
    const secret = credentials.appSecret || process.env.META_APP_SECRET;
    if (!secret) {
      console.error(
        "verifyWebhookSignature: no appSecret on the channel and META_APP_SECRET is not set — rejecting"
      );
      return false;
    }

    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

    // Constant-time compare to avoid timing attacks
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  parseWebhook(payload: any): NormalizedMessage[] {
    const messages: NormalizedMessage[] = [];

    const entries = payload?.entry ?? [];
    for (const entry of entries) {
      const changes = entry?.changes ?? [];
      for (const change of changes) {
        const value = change?.value;
        const contacts = value?.contacts ?? [];
        const contactName = contacts[0]?.profile?.name;

        for (const msg of value?.messages ?? []) {
          let mediaId: string | undefined;
          let text = msg.text?.body ?? extractInteractiveReplyText(msg);

          if (msg.type === "image") {
            mediaId = msg.image?.id;
            if (!text && msg.image?.caption) text = msg.image.caption;
          } else if (msg.type === "document") {
            mediaId = msg.document?.id;
            if (!text) text = msg.document?.caption || msg.document?.filename;
          } else if (msg.type === "audio" || msg.type === "voice") {
            mediaId = msg.audio?.id || msg.voice?.id;
          } else if (msg.type === "video") {
            mediaId = msg.video?.id;
            if (!text && msg.video?.caption) text = msg.video.caption;
          } else if (msg.type === "sticker") {
            mediaId = msg.sticker?.id;
          } else if (msg.type === "order") {
            const items = msg.order?.product_items || [];
            const itemsDesc = items.map((i: any) => `${i.quantity || 1}x ${i.product_retailer_id || "item"}`).join(", ");
            text = `🛒 Order received: ${itemsDesc || "Cart items"}${msg.order?.text ? ` (Note: "${msg.order.text}")` : ""}`;
          }

          let receivedAt = new Date();
          if (msg.timestamp) {
            const ts = Number(msg.timestamp);
            if (!isNaN(ts) && ts > 0) {
              receivedAt = ts > 1e11 ? new Date(ts) : new Date(ts * 1000);
            }
          }

          messages.push({
            channelExternalContactId: msg.from,
            contactName,
            type: mapMessageType(msg.type),
            text,
            mediaUrl: mediaId, // media needs a follow-up media-download call
            providerMessageId: msg.id,
            raw: msg,
            receivedAt,
          });
        }
      }
    }

    return messages;
  }

  parseStatusWebhook(payload: any): MessageStatusUpdate[] {
    const statusUpdates: MessageStatusUpdate[] = [];

    const entries = payload?.entry ?? [];
    for (const entry of entries) {
      const changes = entry?.changes ?? [];
      for (const change of changes) {
        const value = change?.value;

        // Status updates come in value.statuses array (separate from value.messages)
        for (const status of value?.statuses ?? []) {
          const errorInfo = status.errors?.[0];
          let statusTimestamp = new Date();
          if (status.timestamp) {
            const ts = Number(status.timestamp);
            if (!isNaN(ts) && ts > 0) {
              statusTimestamp = ts > 1e11 ? new Date(ts) : new Date(ts * 1000);
            }
          }

          let errorMessage: string | undefined;
          if (errorInfo) {
            const details = errorInfo.error_data?.details;
            const title = errorInfo.title;
            const msg = errorInfo.message;
            if (details && (title || msg)) {
              const header = title || msg;
              errorMessage = header && !details.toLowerCase().includes(header.toLowerCase()) ? `${header}: ${details}` : details;
            } else {
              errorMessage = details || msg || title || undefined;
            }
          }

          statusUpdates.push({
            providerMessageId: status.id,
            status: mapStatusValue(status.status),
            errorCode: errorInfo?.code ? String(errorInfo.code) : undefined,
            errorMessage,
            timestamp: statusTimestamp,
          });
        }
      }
    }

    return statusUpdates;
  }

  async send(
    message: OutboundMessage,
    credentials: { phoneNumberId: string; accessToken: string; apiBaseUrl?: string }
  ): Promise<{ providerMessageId: string }> {
    if (!credentials?.phoneNumberId) {
      throw new Error("Channel is missing phoneNumberId in credentials. Please reconnect the WhatsApp channel.");
    }
    if (!credentials?.accessToken) {
      throw new Error("Channel is missing accessToken in credentials. Please reconnect the WhatsApp channel.");
    }

    const baseUrl = credentials.apiBaseUrl || "https://graph.facebook.com/v20.0";
    const url = `${baseUrl}/${credentials.phoneNumberId}/messages`;

    const body = buildOutboundBody(message);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout to avoid reverse-proxy 502 Bad Gateway

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (networkErr: any) {
      if (networkErr?.name === "AbortError") {
        throw new Error("WhatsApp API request timed out after 15 seconds. Please check Meta network connectivity.");
      }
      throw new Error(`WhatsApp API network connection error: ${networkErr?.message || networkErr}`);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const errText = await response.text();
      let errorMsg = `WhatsApp send failed (${response.status}): ${errText}`;
      try {
        const parsed = JSON.parse(errText);
        const metaErr = parsed?.error;
        if (metaErr) {
          if (metaErr.code === 131047) {
            errorMsg = "WhatsApp 24-hour customer window expired. You must use an approved template to re-engage with this customer.";
          } else if (metaErr.code === 131048 || metaErr.code === 131056 || metaErr.code === 80007) {
            errorMsg = `WhatsApp 24-hour messaging limit tier reached (${metaErr.code}): ${metaErr.message}. Broadcast recipient was capped under your Meta messaging tier.`;
          } else if (metaErr.message) {
            errorMsg = `WhatsApp API error (${metaErr.code || response.status}): ${metaErr.message}`;
            if (metaErr.error_data?.details && !metaErr.message.toLowerCase().includes(metaErr.error_data.details.toLowerCase())) {
              errorMsg += ` - ${metaErr.error_data.details}`;
            }
          }
        }
      } catch {}
      throw new Error(errorMsg);
    }

    const data = (await response.json()) as { messages?: { id: string }[] };
    return { providerMessageId: data.messages?.[0]?.id ?? "" };
  }

  /**
   * WhatsApp media is a two-step fetch: NormalizedMessage.mediaUrl actually
   * holds a media ID (see parseWebhook above), not a real URL. Step 1 asks
   * Graph API for a temporary signed URL for that ID; step 2 downloads the
   * actual bytes from it (which itself still requires the bearer token —
   * Meta's temporary URLs aren't public).
   */
  async downloadMedia(
    mediaId: string,
    credentials: { accessToken: string; apiBaseUrl?: string }
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const baseUrl = credentials.apiBaseUrl || "https://graph.facebook.com/v20.0";

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    let lookupResponse: Response;
    try {
      lookupResponse = await fetch(`${baseUrl}/${mediaId}`, {
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!lookupResponse.ok) {
      throw new Error(`WhatsApp media lookup failed (${lookupResponse.status}): ${await lookupResponse.text()}`);
    }
    const lookup = (await lookupResponse.json()) as { url?: string; mime_type?: string };
    if (!lookup.url) throw new Error("WhatsApp media lookup response missing url");

    const dlController = new AbortController();
    const dlTimeoutId = setTimeout(() => dlController.abort(), 15000);

    let fileResponse: Response;
    try {
      fileResponse = await fetch(lookup.url, {
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
        signal: dlController.signal,
      });
    } finally {
      clearTimeout(dlTimeoutId);
    }

    if (!fileResponse.ok) {
      throw new Error(`WhatsApp media download failed (${fileResponse.status})`);
    }
    const buffer = Buffer.from(await fileResponse.arrayBuffer());
    return { buffer, contentType: lookup.mime_type || "application/octet-stream" };
  }
}

function mapMessageType(waType: string): NormalizedMessage["type"] {
  switch (waType) {
    case "text":
      return "text";
    case "image":
      return "image";
    case "document":
      return "document";
    case "audio":
    case "voice":
      return "audio";
    case "video":
      return "video";
    case "sticker":
      return "sticker";
    case "order":
      return "order";
    case "button":
    case "interactive":
      return "button";
    default:
      return "unknown";
  }
}

function mapStatusValue(waStatus: string): MessageStatusUpdate["status"] {
  switch (waStatus) {
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "read":
      return "read";
    case "failed":
      return "failed";
    default:
      return "sent";
  }
}

/**
 * A tapped quick-reply button or list item arrives as msg.button.text or
 * msg.interactive.{button_reply,list_reply}.title, never as msg.text. The
 * flow engine's `input` nodes only look at NormalizedMessage.text, so
 * without this a button tap would silently fail to advance a waiting flow.
 */
function extractInteractiveReplyText(msg: any): string | undefined {
  if (msg.button?.text) return msg.button.text;
  const interactive = msg.interactive;
  return interactive?.button_reply?.title ?? interactive?.list_reply?.title;
}

/** Parameters of one carousel card (header media, body variables, button values). */
function buildCarouselCard(card: OutboundCarouselCard, cardIndex: number) {
  const mediaType = card.headerType.toLowerCase();
  const components: Record<string, unknown>[] = [
    {
      type: "header",
      parameters: [{ type: mediaType, [mediaType]: { link: card.headerValue } }],
    },
  ];

  if (card.bodyParams && card.bodyParams.length > 0) {
    components.push({
      type: "body",
      parameters: card.bodyParams.map((text) => ({ type: "text", text })),
    });
  }

  for (const button of card.buttons ?? []) {
    if (button.subType === "quick_reply") {
      // The payload comes back on the tap; use the label so flows can branch on it like any other reply.
      const payload = button.param || button.text || `card${cardIndex + 1}_button${button.index + 1}`;
      components.push({
        type: "button",
        sub_type: "quick_reply",
        index: String(button.index),
        parameters: [{ type: "payload", payload }],
      });
    } else if (button.param) {
      components.push({
        type: "button",
        sub_type: "url",
        index: String(button.index),
        parameters: [{ type: "text", text: button.param }],
      });
    }
  }

  return { card_index: cardIndex, components };
}

function buildOutboundBody(message: OutboundMessage) {
  const base = {
    messaging_product: "whatsapp",
    to: message.toExternalContactId,
  };

  if (message.type === "text") {
    return { ...base, type: "text", text: { body: message.text } };
  }
  if (message.type === "template") {
    const components: any[] = [];

    // Header component
    if (message.headerType && message.headerValue) {
      if (message.headerType === "TEXT") {
        components.push({
          type: "header",
          parameters: [{ type: "text", text: message.headerValue }],
        });
      } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(message.headerType)) {
        const paramType = message.headerType.toLowerCase();
        const mediaObj: Record<string, any> = { link: message.headerValue };
        if (message.headerType === "DOCUMENT" && message.filename) {
          mediaObj.filename = message.filename;
        }
        components.push({
          type: "header",
          parameters: [
            {
              type: paramType,
              [paramType]: mediaObj,
            },
          ],
        });
      }
    }

    // Body parameters
    if (message.templateParams && Object.keys(message.templateParams).length > 0) {
      const paramKeys = Object.keys(message.templateParams).sort((a, b) => {
        const numA = Number(a);
        const numB = Number(b);
        if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
        return a.localeCompare(b);
      });

      components.push({
        type: "body",
        parameters: paramKeys.map((k) => ({
          type: "text",
          text: message.templateParams![k],
        })),
      });
    }

    // Media-card carousel: one entry per card, in the template's card order.
    if (message.carouselCards && message.carouselCards.length > 0) {
      components.push({
        type: "carousel",
        cards: message.carouselCards.map((card, cardIndex) => buildCarouselCard(card, cardIndex)),
      });
    }

    return {
      ...base,
      type: "template",
      template: {
        name: message.templateName,
        language: { code: message.templateLanguage || "en" },
        components,
      },
    };
  }
  if (message.type === "product") {
    return {
      ...base,
      type: "interactive",
      interactive: {
        type: "product",
        body: message.text ? { text: message.text } : undefined,
        action: {
          catalog_id: message.catalogId,
          product_retailer_id: message.productRetailerId,
        },
      },
    };
  }
  if (message.type === "product_list") {
    return {
      ...base,
      type: "interactive",
      interactive: {
        type: "product_list",
        header: message.headerValue ? { type: "text", text: message.headerValue } : undefined,
        body: { text: message.text || "Explore our products" },
        action: {
          catalog_id: message.catalogId,
          sections: message.sections || [],
        },
      },
    };
  }
  // image / document / audio / video / sticker
  if (message.type === "image") {
    return {
      ...base,
      type: "image",
      image: {
        link: message.mediaUrl,
        caption: message.text || undefined,
      },
    };
  }
  if (message.type === "video") {
    return {
      ...base,
      type: "video",
      video: {
        link: message.mediaUrl,
        caption: message.text || undefined,
      },
    };
  }
  if (message.type === "document") {
    return {
      ...base,
      type: "document",
      document: {
        link: message.mediaUrl,
        caption: message.text || undefined,
        filename: message.filename || undefined,
      },
    };
  }
  if (message.type === "audio") {
    return {
      ...base,
      type: "audio",
      audio: {
        link: message.mediaUrl,
      },
    };
  }
  if (message.type === "sticker") {
    return {
      ...base,
      type: "sticker",
      sticker: {
        link: message.mediaUrl,
      },
    };
  }

  return {
    ...base,
    type: message.type,
    [message.type]: { link: message.mediaUrl },
  };
}
