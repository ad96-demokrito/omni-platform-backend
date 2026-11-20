import { resolveHeaderMediaUrl } from "../../db/object-storage";
import { isSafeMediaKey, tenantOwnsKey } from "../media/media.service";
import type { OutboundCarouselCard } from "./adapters/channel-adapter.interface";

/**
 * Per-send data for a media-card carousel template: the media, body variables and button
 * parameters of every card. Shared by inbox, campaigns and flows so they validate, authorise and
 * resolve cards identically. Input is untrusted JSON (request body or a stored definition).
 */

export const CAROUSEL_SEND_MAX_CARDS = 10;
const MAX_BODY_PARAMS = 10;
const MAX_BUTTONS_PER_CARD = 2;
const MAX_PARAM_LENGTH = 1024;
const MAX_URL_LENGTH = 2000;
const MAX_BUTTON_TEXT_LENGTH = 25;

export interface CarouselCardButtonInput {
  index: number;
  subType: "quick_reply" | "url";
  param?: string;
  text?: string;
}

export interface CarouselCardInput {
  headerType: "IMAGE" | "VIDEO";
  /** Uploaded file; always preferred over `headerValue` and signed fresh at send time. */
  mediaStorageKey?: string;
  /** Pasted URL, or a {{variable}} for campaigns and flows. */
  headerValue?: string;
  bodyParams?: string[];
  buttons?: CarouselCardButtonInput[];
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400, statusCode: 400 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, max: number, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > max) {
    throw badRequest(`${label} must be text of ${max} characters or fewer`);
  }
  return value;
}

function normalizeButton(raw: unknown, cardNo: number): CarouselCardButtonInput {
  const label = `Card ${cardNo} button`;
  if (!isRecord(raw)) throw badRequest(`${label} is invalid`);
  const { index, subType } = raw;
  if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= MAX_BUTTONS_PER_CARD) {
    throw badRequest(`${label} index must be 0 or 1`);
  }
  if (subType !== "quick_reply" && subType !== "url") {
    throw badRequest(`${label} type must be quick_reply or url`);
  }
  return {
    index: index as number,
    subType,
    param: optionalString(raw.param, MAX_URL_LENGTH, `${label} parameter`),
    text: optionalString(raw.text, MAX_BUTTON_TEXT_LENGTH, `${label} text`),
  };
}

/** Validates and bounds carousel cards from an untrusted source. Throws a 400 error when invalid. */
export function normalizeCarouselCards(raw: unknown): CarouselCardInput[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > CAROUSEL_SEND_MAX_CARDS) {
    throw badRequest(`carouselCards must list 1 to ${CAROUSEL_SEND_MAX_CARDS} cards`);
  }
  return raw.map((card, i): CarouselCardInput => {
    const cardNo = i + 1;
    if (!isRecord(card)) throw badRequest(`Card ${cardNo} is invalid`);
    if (card.headerType !== "IMAGE" && card.headerType !== "VIDEO") {
      throw badRequest(`Card ${cardNo} headerType must be IMAGE or VIDEO`);
    }
    if (card.mediaStorageKey !== undefined && !isSafeMediaKey(card.mediaStorageKey)) {
      throw badRequest(`Card ${cardNo} has an invalid media reference`);
    }
    const mediaStorageKey = card.mediaStorageKey as string | undefined;
    const headerValue = optionalString(card.headerValue, MAX_URL_LENGTH, `Card ${cardNo} media URL`);
    if (!mediaStorageKey && !headerValue) {
      throw badRequest(`Card ${cardNo} needs ${card.headerType === "IMAGE" ? "an image" : "a video"}`);
    }

    let bodyParams: string[] | undefined;
    if (card.bodyParams !== undefined) {
      if (
        !Array.isArray(card.bodyParams) ||
        card.bodyParams.length > MAX_BODY_PARAMS ||
        card.bodyParams.some((p) => typeof p !== "string" || p.length > MAX_PARAM_LENGTH)
      ) {
        throw badRequest(`Card ${cardNo} bodyParams must be up to ${MAX_BODY_PARAMS} short texts`);
      }
      bodyParams = card.bodyParams as string[];
    }

    let buttons: CarouselCardButtonInput[] | undefined;
    if (card.buttons !== undefined) {
      if (!Array.isArray(card.buttons) || card.buttons.length > MAX_BUTTONS_PER_CARD) {
        throw badRequest(`Card ${cardNo} can have at most ${MAX_BUTTONS_PER_CARD} buttons`);
      }
      buttons = card.buttons.map((b) => normalizeButton(b, cardNo));
    }

    return { headerType: card.headerType, mediaStorageKey, headerValue, bodyParams, buttons };
  });
}

/** Applies `fn` (e.g. {{variable}} interpolation) to every free-text value of the cards. */
export function mapCarouselCardTexts(
  cards: CarouselCardInput[],
  fn: (value: string) => string
): CarouselCardInput[] {
  return cards.map((card) => ({
    ...card,
    headerValue: card.headerValue ? fn(card.headerValue) : card.headerValue,
    bodyParams: card.bodyParams?.map(fn),
    buttons: card.buttons?.map((b) => ({ ...b, param: b.param ? fn(b.param) : b.param })),
  }));
}

/** A stored file must belong to the tenant sending it. Throws a 400 error otherwise. */
export function assertTenantOwnsCarouselMedia(tenantId: string, cards: CarouselCardInput[]): void {
  for (const card of cards) {
    if (card.mediaStorageKey && !tenantOwnsKey(tenantId, card.mediaStorageKey)) {
      throw badRequest("Invalid media reference");
    }
  }
}

export interface PreparedCarousel {
  /** Safe to persist with the message: no signed URLs, which expire. */
  stored: CarouselCardInput[];
  /** What the channel adapter sends: media resolved to URLs Meta can fetch. */
  outbound: OutboundCarouselCard[];
}

/** Validates, authorises and resolves the cards of one carousel send. */
export async function prepareCarouselForSend(tenantId: string, raw: unknown): Promise<PreparedCarousel> {
  const cards = normalizeCarouselCards(raw);
  assertTenantOwnsCarouselMedia(tenantId, cards);

  const outbound: OutboundCarouselCard[] = [];
  for (const card of cards) {
    const headerValue = await resolveHeaderMediaUrl(card.mediaStorageKey, card.headerValue);
    if (!headerValue) throw badRequest("A carousel card is missing its media");
    outbound.push({
      headerType: card.headerType,
      headerValue,
      bodyParams: card.bodyParams,
      buttons: card.buttons,
    });
  }
  return { stored: cards, outbound };
}
