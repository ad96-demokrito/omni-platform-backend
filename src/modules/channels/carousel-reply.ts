/**
 * A quick-reply tap on a carousel card comes back as the same button label whichever card it was on
 * ("Buy now" on card 1 looks like "Buy now" on card 3). The button's payload is the only thing we
 * control that Meta returns, so every card button is sent with a payload naming its card:
 *
 *   card2:Buy now   →   card 2 (1-based, as shown to people), button "Buy now"
 *
 * Meta's docs do not promise a card index in the tap webhook, so we do not rely on one.
 */

const CARD_PAYLOAD_PATTERN = /^card(\d{1,2}):([\s\S]*)$/;
const MAX_CARD_NUMBER = 10;
/** Meta limits a quick-reply payload to 256 characters. */
const MAX_PAYLOAD_LENGTH = 256;

export interface CarouselReply {
  /** 1-based position of the card the customer tapped on. */
  cardNumber: number;
  /** Label of the button they tapped. */
  button: string;
}

export function buildCarouselReplyPayload(cardNumber: number, buttonLabel: string): string {
  return `card${cardNumber}:${buttonLabel}`.slice(0, MAX_PAYLOAD_LENGTH);
}

/** Returns the card a tap belongs to, or null when the payload is not one of ours. */
export function parseCarouselReplyPayload(payload: unknown): CarouselReply | null {
  if (typeof payload !== "string") return null;
  const match = CARD_PAYLOAD_PATTERN.exec(payload);
  if (!match) return null;
  const cardNumber = Number(match[1]);
  if (cardNumber < 1 || cardNumber > MAX_CARD_NUMBER) return null;
  return { cardNumber, button: match[2] };
}
