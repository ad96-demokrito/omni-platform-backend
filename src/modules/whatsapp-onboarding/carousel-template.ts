import { isSafeMediaKey } from "../media/media.service";

/**
 * Validation for media-card carousel templates (Meta: "Media card carousel templates").
 * Runs at the route boundary on untrusted JSON, so everything is narrowed from `unknown`.
 */

export const CAROUSEL_MIN_CARDS = 2;
export const CAROUSEL_MAX_CARDS = 10;
export const CAROUSEL_BODY_MAX = 1024;
export const CAROUSEL_CARD_BODY_MAX = 160;
export const CAROUSEL_MAX_CARD_BUTTONS = 2;
export const CAROUSEL_BUTTON_TEXT_MAX = 25;
const URL_MAX = 2000;
const PHONE_MAX = 20;
const CARD_BUTTON_TYPES = ["QUICK_REPLY", "URL", "PHONE_NUMBER"];
const CARD_HEADER_FORMATS = ["IMAGE", "VIDEO"];
const VARIABLE_PATTERN = /\{\{(\d+)\}\}/g;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function distinctVariables(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(VARIABLE_PATTERN), (m) => m[1])));
}

function findComponent(components: unknown[], type: string): Json | undefined {
  return components.find((c): c is Json => isRecord(c) && c.type === type);
}

/** True when the request contains a CAROUSEL component. */
export function hasCarousel(components: unknown): boolean {
  return Array.isArray(components) && components.some((c) => isRecord(c) && c.type === "CAROUSEL");
}

/** Every `mediaStorageKey` in the request (top-level header and carousel card headers). */
export function collectMediaStorageKeys(components: unknown): unknown[] {
  if (!Array.isArray(components)) return [];
  const keys: unknown[] = [];
  const visit = (list: unknown[]): void => {
    for (const comp of list) {
      if (!isRecord(comp)) continue;
      if (comp.mediaStorageKey !== undefined) keys.push(comp.mediaStorageKey);
      if (Array.isArray(comp.cards)) {
        for (const card of comp.cards) {
          if (isRecord(card) && Array.isArray(card.components)) visit(card.components);
        }
      }
    }
  };
  visit(components);
  return keys;
}

/** Returns a human-readable error, or null when the card's button is valid. */
function validateCardButton(button: unknown, cardNo: number): string | null {
  const label = `Card ${cardNo}`;
  if (!isRecord(button)) return `${label}: invalid button.`;
  const type = asString(button.type);
  if (!CARD_BUTTON_TYPES.includes(type)) {
    return `${label}: carousel buttons must be Quick reply, URL or Phone number.`;
  }
  const text = asString(button.text).trim();
  if (!text) return `${label}: every button needs text.`;
  if (text.length > CAROUSEL_BUTTON_TEXT_MAX) {
    return `${label}: button text must be ${CAROUSEL_BUTTON_TEXT_MAX} characters or fewer.`;
  }
  if (type === "URL") {
    const url = asString(button.url).trim();
    if (!/^https?:\/\//i.test(url) || url.length > URL_MAX) {
      return `${label}: URL buttons need an http(s) URL of ${URL_MAX} characters or fewer.`;
    }
    const variables = url.match(VARIABLE_PATTERN) ?? [];
    if (variables.length > 1 || (variables.length === 1 && !url.endsWith("{{1}}"))) {
      return `${label}: a URL button supports one variable, {{1}}, at the end of the URL.`;
    }
    if (variables.length === 1 && !button.example) {
      return `${label}: provide a sample value for the URL button variable.`;
    }
  }
  if (type === "PHONE_NUMBER") {
    const phone = asString(button.phone_number ?? button.phoneNumber).trim();
    if (!phone || phone.length > PHONE_MAX) {
      return `${label}: phone buttons need a phone number of ${PHONE_MAX} characters or fewer.`;
    }
  }
  return null;
}

/**
 * Validates a carousel create-template request. Returns an error message, or null when the
 * request is valid (or contains no carousel at all).
 */
export function validateCarouselTemplate(category: unknown, components: unknown): string | null {
  if (!hasCarousel(components)) return null;
  const list = components as unknown[];

  if (category !== "MARKETING") {
    return "Carousel templates are only available in the MARKETING category.";
  }
  if (list.filter((c) => isRecord(c) && c.type === "CAROUSEL").length !== 1) {
    return "A template can contain only one carousel.";
  }
  const unsupportedTop = list.find(
    (c) => isRecord(c) && ["HEADER", "FOOTER", "BUTTONS"].includes(asString(c.type))
  );
  if (unsupportedTop) {
    return "Carousel templates cannot have a header, footer or buttons outside the cards.";
  }

  const body = findComponent(list, "BODY");
  const bodyText = body ? asString(body.text).trim() : "";
  if (!bodyText) return "Carousel templates need a body text above the cards.";
  if (bodyText.length > CAROUSEL_BODY_MAX) {
    return `Body text must be ${CAROUSEL_BODY_MAX} characters or fewer.`;
  }

  const carousel = findComponent(list, "CAROUSEL");
  const cards = carousel?.cards;
  if (!Array.isArray(cards) || cards.length < CAROUSEL_MIN_CARDS || cards.length > CAROUSEL_MAX_CARDS) {
    return `A carousel needs between ${CAROUSEL_MIN_CARDS} and ${CAROUSEL_MAX_CARDS} cards.`;
  }

  let firstFormat = "";
  let firstHasBody: boolean | undefined;
  let firstButtonShape = "";

  for (let i = 0; i < cards.length; i += 1) {
    const cardNo = i + 1;
    const card = cards[i];
    if (!isRecord(card) || !Array.isArray(card.components)) return `Card ${cardNo}: invalid card.`;
    const parts = card.components as unknown[];

    const unknownPart = parts.find(
      (c) => !isRecord(c) || !["HEADER", "BODY", "BUTTONS"].includes(asString(c.type))
    );
    if (unknownPart) return `Card ${cardNo}: cards only support a media header, body and buttons.`;

    const header = findComponent(parts, "HEADER");
    const format = header ? asString(header.format) : "";
    if (!header || !CARD_HEADER_FORMATS.includes(format)) {
      return `Card ${cardNo}: every card needs an image or video header.`;
    }
    if (i === 0) firstFormat = format;
    else if (format !== firstFormat) return "All cards must use the same media type (image or video).";

    const example = isRecord(header.example) ? header.example : {};
    const handle = Array.isArray(example.header_handle) ? example.header_handle[0] : undefined;
    if (!header.mediaStorageKey && !asString(handle).trim()) {
      return `Card ${cardNo}: upload a sample ${format.toLowerCase()} for the header.`;
    }
    if (header.mediaStorageKey !== undefined && !isSafeMediaKey(header.mediaStorageKey)) {
      return `Card ${cardNo}: invalid media reference.`;
    }

    const cardBody = findComponent(parts, "BODY");
    const hasBody = Boolean(cardBody);
    if (i === 0) firstHasBody = hasBody;
    else if (hasBody !== firstHasBody) return "Either every card has a body text or none does.";
    if (cardBody) {
      const text = asString(cardBody.text).trim();
      if (!text) return `Card ${cardNo}: body text cannot be empty.`;
      if (text.length > CAROUSEL_CARD_BODY_MAX) {
        return `Card ${cardNo}: body text must be ${CAROUSEL_CARD_BODY_MAX} characters or fewer.`;
      }
      const variables = distinctVariables(text);
      if (variables.length > 0) {
        const bodyExample = isRecord(cardBody.example) ? cardBody.example : {};
        const sampleRow = Array.isArray(bodyExample.body_text) ? bodyExample.body_text[0] : undefined;
        if (!Array.isArray(sampleRow) || sampleRow.length !== variables.length) {
          return `Card ${cardNo}: provide a sample value for every body variable.`;
        }
      }
    }

    const buttons = findComponent(parts, "BUTTONS");
    const buttonList = buttons && Array.isArray(buttons.buttons) ? buttons.buttons : [];
    if (buttonList.length < 1 || buttonList.length > CAROUSEL_MAX_CARD_BUTTONS) {
      return `Card ${cardNo}: add 1 or ${CAROUSEL_MAX_CARD_BUTTONS} buttons.`;
    }
    for (const button of buttonList) {
      const buttonError = validateCardButton(button, cardNo);
      if (buttonError) return buttonError;
    }
    const shape = buttonList.map((b) => asString((b as Json).type)).join(",");
    if (i === 0) firstButtonShape = shape;
    else if (shape !== firstButtonShape) return "All cards must have the same buttons, in the same order.";
  }

  return null;
}
