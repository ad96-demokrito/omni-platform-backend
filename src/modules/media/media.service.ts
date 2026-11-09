import crypto from "crypto";
import { getMediaDownloadUrl } from "../../db/object-storage";

/**
 * Media files are served through `GET /api/media/file`, which accepts either a tenant/visitor
 * login token or an HMAC signature over `key` + expiry. The signed form is what goes into message
 * payloads, so the inbox, the webchat widget, outgoing webhooks and WhatsApp/Telegram can all fetch
 * a file without holding a session.
 */

const MAX_KEY_LENGTH = 512;
const SIGNATURE_BUCKET_SECONDS = 60 * 60;
const SIGNED_URL_TTL_SECONDS = 23 * 60 * 60;
const PROVIDER_URL_TTL_SECONDS = 24 * 60 * 60;

/** Same dev fallback as the other token code; production must set JWT_SECRET (see §3 of CLAUDE.md). */
const SIGNING_KEY = crypto
  .createHash("sha256")
  .update(`media-url:${process.env.JWT_SECRET || "dev-secret-change-me"}`)
  .digest();

/** Base URL (no trailing slash) that outside services use to reach this API, e.g. https://api.example.com */
function publicApiBase(): string {
  return (process.env.PUBLIC_API_URL || "").trim().replace(/\/+$/, "");
}

function signature(key: string, expiresAt: number): string {
  return crypto.createHmac("sha256", SIGNING_KEY).update(`${key}\n${expiresAt}`).digest("base64url");
}

/** Rejects keys that could escape a tenant prefix or are not plausible object keys. */
export function isSafeMediaKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= MAX_KEY_LENGTH &&
    !key.startsWith("/") &&
    !key.includes("..") &&
    !key.includes("\\") &&
    !key.includes("\0")
  );
}

/**
 * Signed URL for a stored file. The expiry is rounded to the hour so the URL stays identical across
 * repeated reads (the widget polls), which keeps images cached and stops them flickering.
 * Relative unless PUBLIC_API_URL is set.
 */
export function signedMediaUrl(key: string): string {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = (Math.floor(now / SIGNATURE_BUCKET_SECONDS) + 1) * SIGNATURE_BUCKET_SECONDS + SIGNED_URL_TTL_SECONDS;
  const sig = signature(key, expiresAt);
  return `${publicApiBase()}/api/media/file?key=${encodeURIComponent(key)}&exp=${expiresAt}&sig=${sig}`;
}

export function verifyMediaSignature(key: string, expiresAt: unknown, sig: unknown): boolean {
  if (typeof sig !== "string" || typeof expiresAt !== "string" || !/^\d{1,12}$/.test(expiresAt)) return false;
  const expiry = Number(expiresAt);
  if (expiry < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(signature(key, expiry));
  const provided = Buffer.from(sig);
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

/**
 * URL for WhatsApp/Telegram to download a file from. Meta and Telegram fetch it from their own
 * servers, so it must be publicly reachable: with PUBLIC_API_URL set we hand out a signed link to
 * this API, otherwise we fall back to the object-store presigned URL (the previous behaviour).
 */
export async function providerMediaUrl(key: string): Promise<string> {
  if (publicApiBase()) {
    const expiresAt = Math.floor(Date.now() / 1000) + PROVIDER_URL_TTL_SECONDS;
    return `${publicApiBase()}/api/media/file?key=${encodeURIComponent(key)}&exp=${expiresAt}&sig=${signature(key, expiresAt)}`;
  }
  return getMediaDownloadUrl(key, PROVIDER_URL_TTL_SECONDS);
}

/** Old messages kept only a `/api/media/file?key=…` URL; recover the storage key from it. */
export function keyFromMediaUrl(url: unknown): string | undefined {
  if (typeof url !== "string" || !url.includes("/api/media/file")) return undefined;
  try {
    const key = new URL(url, "http://localhost").searchParams.get("key");
    return isSafeMediaKey(key) ? key : undefined;
  } catch {
    return undefined;
  }
}

/** Keys a tenant user may read: `<tenantId>/…` (inbox, templates) and `webchat/<tenantId>/…` (visitor uploads). */
export function tenantOwnsKey(tenantId: string, key: string): boolean {
  return key.startsWith(`${tenantId}/`) || key.startsWith(`webchat/${tenantId}/`);
}

/** Keys a webchat visitor may read: only files of their own conversation. */
export function visitorOwnsKey(tenantId: string, conversationId: string, key: string): boolean {
  return key.startsWith(`${tenantId}/${conversationId}/`) || key.startsWith(`webchat/${tenantId}/${conversationId}/`);
}
