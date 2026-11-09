import { Request, Response, NextFunction } from "express";
import { logger, redactUrl, sanitizeMeta } from "../utils/logger";
import { AuthedRequest } from "./auth";

/**
 * Global Express Error Handling Middleware.
 * Captures, logs with full contextual metadata, and returns clean structured error responses.
 */
export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const reqId = req.id || (req.headers["x-request-id"] as string);
  const authed = req as AuthedRequest;
  const tenantId = authed.auth?.tenantId;
  const userId = authed.auth?.userId;

  const scopedLogger = req.logger || logger.child({
    module: "error-handler",
    reqId,
    tenantId,
    userId,
  });

  const method = req.method;
  const url = redactUrl(req.originalUrl || req.url);

  const errorContext = {
    method,
    url,
    reqId,
    tenantId,
    userId,
    query: sanitizeMeta(req.query),
    body: sanitizeMeta(req.body),
    ip: req.ip || req.socket.remoteAddress,
  };

  // Upload/body size failures carry no HTTP status of their own; map them so clients see a 4xx, not a 500.
  const isUploadError = err?.name === "MulterError";
  const isFileTooLarge = err?.code === "LIMIT_FILE_SIZE" || err?.type === "entity.too.large";
  const clientErrorCode = isFileTooLarge ? "FILE_TOO_LARGE" : isUploadError ? "UPLOAD_ERROR" : undefined;

  // Client-specified status code
  const statusCode = isFileTooLarge
    ? 413
    : isUploadError
      ? 400
      : typeof err?.statusCode === "number" ? err.statusCode : typeof err?.status === "number" ? err.status : 500;
  const clientMessage = isFileTooLarge
    ? "The file is too large to upload."
    : isUploadError
      ? "The file upload was invalid."
      : err?.message || "Client request error";
  const errorMessage = statusCode < 500
    ? clientMessage
    : (process.env.NODE_ENV === "development" ? (err?.message || "Internal server error") : "Internal server error");

  // Log full stack only for 500+ unhandled server errors; warn for 4xx client errors
  if (statusCode >= 500) {
    scopedLogger.error(
      `Unhandled Error processing ${method} ${url}: ${err?.message || err}`,
      err,
      errorContext
    );
  } else {
    scopedLogger.warn(
      `Client error (${statusCode}) processing ${method} ${url}: ${err?.message || err}`,
      errorContext
    );
  }

  if (res.headersSent) {
    return;
  }

  // Handle known Postgres constraint errors
  if (err?.code === "23503") {
    res.status(400).json({
      error: "Request refers to a record that does not exist",
      code: "FOREIGN_KEY_VIOLATION",
      requestId: reqId,
    });
    return;
  }

  if (err?.code === "23505") {
    res.status(409).json({
      error: "A record with these values already exists",
      code: "DUPLICATE_RECORD",
      requestId: reqId,
    });
    return;
  }

  if (err?.code === "23514" || err?.code === "22P02") {
    res.status(400).json({
      error: "Request contains an invalid or malformed value",
      code: "INVALID_INPUT_SYNTAX",
      requestId: reqId,
    });
    return;
  }

  res.status(statusCode).json({
    error: errorMessage,
    code: clientErrorCode || err?.code || (statusCode === 401 ? "UNAUTHORIZED" : statusCode === 403 ? "FORBIDDEN" : statusCode === 404 ? "NOT_FOUND" : statusCode === 400 ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR"),
    requestId: reqId,
    ...(process.env.NODE_ENV === "development" && err?.stack && statusCode >= 500 ? { stack: err.stack } : {}),
  });
}
