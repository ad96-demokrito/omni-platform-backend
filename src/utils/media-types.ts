import { httpError } from "./http-error";

/** The message types an uploaded file can be sent as. Stickers are only sent when requested. */
export type MediaKind = "image" | "video" | "audio" | "document" | "sticker";

const MB = 1024 * 1024;

/**
 * Per-type size caps follow WhatsApp Cloud API limits (the strictest channel we send through);
 * documents are capped by the upload route's multer limit instead.
 */
export const MEDIA_MAX_BYTES: Record<MediaKind, number> = {
  image: 5 * MB,
  video: 16 * MB,
  audio: 16 * MB,
  document: 50 * MB,
  sticker: 500 * 1024,
};

const MIME_TO_KIND: Record<string, MediaKind> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "video/mp4": "video",
  "video/3gpp": "video",
  "video/quicktime": "video",
  "video/webm": "video",
  "audio/aac": "audio",
  "audio/mp4": "audio",
  "audio/mpeg": "audio",
  "audio/amr": "audio",
  "audio/ogg": "audio",
  "audio/webm": "audio",
  "application/pdf": "document",
  "application/msword": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.ms-excel": "document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "document",
  "application/vnd.ms-powerpoint": "document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "document",
  "text/plain": "document",
  "text/csv": "document",
};

/** Used when the browser sends no MIME type or a generic one (octet-stream). */
const EXTENSION_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  "3gp": "video/3gpp",
  mov: "video/quicktime",
  webm: "video/webm",
  aac: "audio/aac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  amr: "audio/amr",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
};

/**
 * Content types safe to render inline (no SVG/HTML). Wider than the upload allow-list because
 * customers can send us GIFs, stickers and WAV voice notes over WhatsApp.
 */
const INLINE_SAFE_CONTENT_TYPE =
  /^(image\/(jpeg|png|webp|gif|bmp)|video\/(mp4|3gpp|quicktime|webm)|audio\/(aac|mp4|mpeg|amr|ogg|webm|wav|x-m4a))$/;

export function isInlineSafeContentType(contentType: string | undefined): boolean {
  return INLINE_SAFE_CONTENT_TYPE.test(normalizeMime(contentType));
}

export interface UploadClassification {
  kind: MediaKind;
  /** Canonical MIME type to store and serve (never the raw client-supplied header). */
  contentType: string;
  maxBytes: number;
}

export function uploadError(statusCode: number, code: string, message: string): Error {
  return Object.assign(httpError(statusCode, message), { code });
}

function normalizeMime(mimetype: string | undefined): string {
  return (mimetype || "").split(";")[0].trim().toLowerCase();
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

/**
 * Decides what an uploaded file is, or rejects it. Throws 400 for unsupported types and 413 when the
 * file is over the limit for its type. `overrides` lets a route allow a larger cap for some kinds.
 */
export function classifyUpload(
  file: { mimetype?: string; originalname: string; size: number },
  options: { requestedKind?: string; overrides?: Partial<Record<MediaKind, number>> } = {}
): UploadClassification {
  let contentType = normalizeMime(file.mimetype);
  if (!MIME_TO_KIND[contentType]) {
    const fromExtension = EXTENSION_TO_MIME[extensionOf(file.originalname)];
    if (!fromExtension) {
      throw uploadError(
        400,
        "UNSUPPORTED_MEDIA_TYPE",
        "This file type is not supported. Send an image (JPG, PNG, WebP), video (MP4), audio (MP3, M4A, OGG), or a document (PDF, Office, TXT, CSV)."
      );
    }
    contentType = fromExtension;
  }

  let kind = MIME_TO_KIND[contentType];
  // A WebP is an ordinary image unless the caller explicitly asks for a sticker, and any file can be
  // sent as a document (e.g. a full-quality photo).
  if (options.requestedKind === "sticker" && contentType === "image/webp") kind = "sticker";
  if (options.requestedKind === "document") kind = "document";

  const maxBytes = options.overrides?.[kind] ?? MEDIA_MAX_BYTES[kind];
  if (file.size > maxBytes) {
    throw uploadError(
      413,
      "FILE_TOO_LARGE",
      `This ${kind} is too large (${formatMb(file.size)}). The limit for ${kind}s is ${formatMb(maxBytes)}.`
    );
  }

  return { kind, contentType, maxBytes };
}

function formatMb(bytes: number): string {
  return bytes < MB ? `${Math.round(bytes / 1024)} KB` : `${Math.round((bytes / MB) * 10) / 10} MB`;
}
