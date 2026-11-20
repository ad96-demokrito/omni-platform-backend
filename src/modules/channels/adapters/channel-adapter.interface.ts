/**
 * Every channel (WhatsApp, Instagram, Facebook, Telegram, Web) implements
 * this interface. Nothing outside the channels module should ever import
 * a channel-specific SDK or know about a channel-specific payload shape —
 * everything downstream (flow engine, inbox, CRM) works on NormalizedMessage.
 */

export interface NormalizedMessage {
  channelExternalContactId: string; // phone number, IG user id, Telegram chat id, etc.
  contactName?: string;
  type: "text" | "image" | "document" | "audio" | "video" | "sticker" | "button" | "order" | "unknown";
  text?: string;
  mediaUrl?: string;
  providerMessageId?: string; // provider message identifier (e.g. WhatsApp WAMID, Telegram message_id)
  raw: unknown; // original payload, kept for debugging/audit
  receivedAt: Date;
}

/** A button parameter of a carousel card; `index` is the button's position on the template card. */
export interface OutboundCarouselButton {
  index: number;
  subType: "quick_reply" | "url";
  /** URL suffix for a url button; payload for a quick_reply (defaults to `text`). */
  param?: string;
  /** Label of the button, used as the quick-reply payload so a tap comes back as that text. */
  text?: string;
}

/** One card of a carousel template send. Media is already resolved to a URL Meta can fetch. */
export interface OutboundCarouselCard {
  headerType: "IMAGE" | "VIDEO";
  headerValue: string;
  bodyParams?: string[];
  buttons?: OutboundCarouselButton[];
}

export interface OutboundMessage {
  toExternalContactId: string;
  type: "text" | "image" | "document" | "audio" | "video" | "sticker" | "template" | "product" | "product_list";
  text?: string;
  mediaUrl?: string;
  filename?: string;
  templateName?: string;
  templateLanguage?: string;
  templateParams?: Record<string, string>;
  headerType?: "TEXT" | "IMAGE" | "DOCUMENT" | "VIDEO";
  headerValue?: string;
  /** Cards of a media-card carousel template; the card count must match the template. */
  carouselCards?: OutboundCarouselCard[];
  catalogId?: string;
  productRetailerId?: string;
  sections?: Array<{
    title: string;
    product_items: Array<{ product_retailer_id: string }>;
  }>;
}

export interface MessageStatusUpdate {
  providerMessageId: string;
  status: "sent" | "delivered" | "read" | "failed";
  errorCode?: string;
  errorMessage?: string;
  timestamp: Date;
}

export interface ChannelAdapter {
  readonly type: "whatsapp" | "instagram" | "facebook" | "telegram" | "web" | "webchat";

  /** Verify the webhook actually came from the provider before trusting the body. */
  verifyWebhookSignature(rawBody: string, headers: Record<string, string | string[] | undefined>, credentials: Record<string, any>): boolean;

  /** Turn a provider-specific webhook payload into our internal shape. */
  parseWebhook(payload: any): NormalizedMessage[];

  /** Parse message delivery status updates from webhook payload (optional - not all channels support this). */
  parseStatusWebhook?(payload: any): MessageStatusUpdate[];

  /** Send a message out through this channel's API. */
  send(message: OutboundMessage, credentials: Record<string, any>): Promise<{ providerMessageId: string }>;

  /**
   * Downloads the actual media bytes for an inbound image/document/audio
   * message. NormalizedMessage.mediaUrl is provider-specific — for WhatsApp
   * it's a media ID requiring a two-step fetch, for Telegram a file_id
   * requiring a getFile lookup first. This method hides that difference so
   * the webhook pipeline never needs to know which provider it's talking to.
   */
  downloadMedia(
    mediaIdOrUrl: string,
    credentials: Record<string, any>
  ): Promise<{ buffer: Buffer; contentType: string }>;
}
