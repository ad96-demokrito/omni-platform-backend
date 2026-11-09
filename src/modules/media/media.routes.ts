import { Router, Request, Response } from "express";
import { Readable } from "stream";
import multer from "multer";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { asyncHandler } from "../../middleware/async-handler";
import { getMediaDownloadUrl, getMediaObject, uploadMedia } from "../../db/object-storage";
import { classifyUpload, isInlineSafeContentType } from "../../utils/media-types";
import { httpError } from "../../utils/http-error";
import {
  isSafeMediaKey,
  signedMediaUrl,
  tenantOwnsKey,
  verifyMediaSignature,
  visitorOwnsKey,
} from "./media.service";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // template headers may carry documents up to WhatsApp's 100MB
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

export const mediaRouter = Router();

/**
 * POST /api/media/upload
 *
 * Authenticated endpoint for uploading media assets (images, videos, documents, audio)
 * for WhatsApp templates, broadcasts, flow nodes, and attachments.
 * Saves file to S3 / MinIO object storage under tenant namespace and returns direct & download URLs.
 */
mediaRouter.post(
  "/upload",
  requireAuth,
  upload.single("file"),
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "No file provided for upload" });
    }

    const { kind, contentType } = classifyUpload(file, { overrides: { document: MAX_UPLOAD_BYTES } });

    const tenantId = req.auth!.tenantId;
    const sanitizedFilename = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `${tenantId}/templates/${Date.now()}-${uuidv4().slice(0, 8)}_${sanitizedFilename}`;

    await uploadMedia({ key, body: file.buffer, contentType });

    // Generate presigned download URL valid for 7 days for Meta / WhatsApp API delivery
    let downloadUrl: string | undefined;
    try {
      downloadUrl = await getMediaDownloadUrl(key, 7 * 86400);
    } catch {
      downloadUrl = undefined;
    }

    const fileUrl = signedMediaUrl(key);

    res.status(201).json({
      success: true,
      key,
      url: downloadUrl || fileUrl,
      downloadUrl: downloadUrl || fileUrl,
      fileUrl,
      filename: file.originalname,
      contentType,
      type: kind,
      size: file.size,
    });
  })
);

/**
 * GET /api/media/download-url?key=<tenantId>/<conversationId>/<file>
 *
 * Generates presigned S3 / MinIO download URL.
 */
mediaRouter.get(
  "/download-url",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const key = req.query.key;
    if (!isSafeMediaKey(key)) return res.status(400).json({ error: "A valid key query parameter is required" });
    // Another tenant's file is reported as missing, same as any other cross-tenant resource.
    if (!tenantOwnsKey(req.auth!.tenantId, key)) return res.status(404).json({ error: "Media not found" });
    const url = await getMediaDownloadUrl(key);
    res.json({ url, downloadUrl: url });
  })
);

interface FileReader {
  tenantId: string;
  /** Set for webchat visitors, who may only read their own conversation's files. */
  conversationId?: string;
}

/** Reads a login token from `Authorization` or `?token=` (needed for <img>/<video> src). Visitor and tenant tokens are both accepted. */
function readerFromToken(req: Request): FileReader | null {
  const header = req.headers.authorization;
  const token =
    (header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined) ||
    (typeof req.query.token === "string" ? req.query.token : undefined);
  if (!token) return null;

  try {
    const payload = jwt.verify(token, JWT_SECRET) as {
      tenantId?: string;
      userId?: string;
      conversationId?: string;
      isVisitor?: boolean;
      role?: string;
    };
    if (!payload.tenantId) return null;
    if (payload.isVisitor || payload.role === "visitor") {
      return payload.conversationId ? { tenantId: payload.tenantId, conversationId: payload.conversationId } : null;
    }
    return payload.userId ? { tenantId: payload.tenantId } : null;
  } catch {
    return null;
  }
}

/** Display name for downloads: the stored file name without the timestamp/uuid prefix we add. */
function downloadNameOf(key: string): string {
  const last = key.slice(key.lastIndexOf("/") + 1);
  return last.replace(/^\d{10,}-([0-9a-f]{8}_)?/, "").replace(/^[0-9a-f-]{36}_/, "") || "file";
}

function contentDisposition(inline: boolean, filename: string): string {
  return `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const RANGE_PATTERN = /^bytes=\d*-\d*$/;

/**
 * GET /api/media/file?key=…&exp=…&sig=…   (signed link, no login needed)
 * GET /api/media/file?key=…&token=…       (tenant or visitor login token)
 *
 * Streams a stored file through the API. Only images, video and audio render inline; everything
 * else is forced to download so an uploaded HTML/SVG file can never run on the API origin.
 */
mediaRouter.get(
  "/file",
  asyncHandler(async (req: Request, res: Response) => {
    const key = req.query.key;
    if (!isSafeMediaKey(key)) return res.status(400).json({ error: "A valid key query parameter is required" });

    const hasSignature = req.query.sig !== undefined || req.query.exp !== undefined;
    if (hasSignature) {
      if (!verifyMediaSignature(key, req.query.exp, req.query.sig)) {
        return res.status(403).json({ error: "This media link is invalid or has expired" });
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
    } else {
      const reader = readerFromToken(req);
      if (!reader) return res.status(401).json({ error: "Authentication required" });
      const allowed = reader.conversationId
        ? visitorOwnsKey(reader.tenantId, reader.conversationId, key)
        : tenantOwnsKey(reader.tenantId, key);
      if (!allowed) return res.status(404).json({ error: "Media not found" });
    }

    const range = typeof req.headers.range === "string" && RANGE_PATTERN.test(req.headers.range)
      ? req.headers.range
      : undefined;

    let media;
    try {
      media = await getMediaObject(key, range);
    } catch (err: unknown) {
      const awsError = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (awsError?.name === "NoSuchKey" || awsError?.$metadata?.httpStatusCode === 404) {
        return res.status(404).json({ error: "File not found in media storage" });
      }
      if (awsError?.$metadata?.httpStatusCode === 416) {
        return res.status(416).json({ error: "Requested range not satisfiable" });
      }
      throw Object.assign(new Error("Failed to retrieve media file"), { cause: err });
    }

    const inline = isInlineSafeContentType(media.contentType);
    res.status(media.contentRange ? 206 : 200);
    res.setHeader("Content-Type", inline ? media.contentType : "application/octet-stream");
    res.setHeader("Content-Disposition", contentDisposition(inline, downloadNameOf(key)));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", `${hasSignature ? "public" : "private"}, max-age=3600`);
    if (media.contentLength !== undefined) res.setHeader("Content-Length", String(media.contentLength));
    if (media.contentRange) res.setHeader("Content-Range", media.contentRange);

    if (!(media.body instanceof Readable)) throw httpError(404, "Media not found");
    media.body.on("error", () => res.destroy());
    media.body.pipe(res);
  })
);
