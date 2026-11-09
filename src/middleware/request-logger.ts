import { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";
import { Logger, logger, redactUrl, sanitizeMeta } from "../utils/logger";
import { AuthedRequest } from "./auth";

declare global {
  namespace Express {
    interface Request {
      id?: string;
      logger?: Logger;
      startTime?: number;
    }
  }
}

/**
 * Request logging & correlation middleware.
 * Assigns a unique X-Request-Id to every request and logs entry / completion metrics.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const reqId = (req.headers["x-request-id"] as string) || uuidv4();
  req.id = reqId;
  res.setHeader("X-Request-Id", reqId);

  const startTime = Date.now();
  req.startTime = startTime;

  // Create scoped logger for this request
  const authed = req as AuthedRequest;
  const tenantId = authed.auth?.tenantId;
  const userId = authed.auth?.userId;

  const reqLogger = logger.child({
    module: "http",
    reqId,
    tenantId,
    userId,
  });
  req.logger = reqLogger;

  // Intercept response finish
  res.on("finish", () => {
    const durationMs = Date.now() - startTime;
    const statusCode = res.statusCode;
    const method = req.method;
    const url = redactUrl(req.originalUrl || req.url);

    // Refresh context in case auth happened mid-flight
    const currentTenantId = (req as AuthedRequest).auth?.tenantId || tenantId;
    const currentUserId = (req as AuthedRequest).auth?.userId || userId;

    const scopedLogger = req.logger || logger.child({
      module: "http",
      reqId,
      tenantId: currentTenantId,
      userId: currentUserId,
    });

    const meta = {
      method,
      url,
      statusCode,
      durationMs,
      ip: req.ip || req.socket.remoteAddress,
      userAgent: req.headers["user-agent"],
      query: sanitizeMeta(req.query),
      tenantId: currentTenantId,
      userId: currentUserId,
    };

    const message = `${method} ${url}`;

    if (statusCode >= 500) {
      scopedLogger.error(`Internal error: ${message}`, undefined, meta);
    } else if (statusCode >= 400) {
      scopedLogger.warn(`Client error: ${message}`, meta);
    } else if (url !== "/health" && !url.startsWith("/api/system/logs")) {
      // Don't flood standard info logs with health checks or log polling
      scopedLogger.info(message, meta);
    }
  });

  next();
}
