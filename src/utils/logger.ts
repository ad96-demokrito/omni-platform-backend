import fs from "fs";
import path from "path";

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  module?: string;
  message: string;
  reqId?: string;
  tenantId?: string;
  userId?: string;
  durationMs?: number;
  statusCode?: number;
  meta?: Record<string, any>;
  error?: {
    name?: string;
    message?: string;
    stack?: string;
    code?: string | number;
    details?: any;
  };
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

const SENSITIVE_KEYS = [
  "password",
  "token",
  "accesstoken",
  "access_token",
  "appsecret",
  "app_secret",
  "secret",
  "authorization",
  "cookie",
  "api_key",
  "apikey",
  "privatekey",
  "private_key",
  "bearer",
];

/** Masks login tokens and media signatures in a request URL before it is logged. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:token|sig)=)[^&#]*/gi, "$1[redacted]");
}

/**
 * Sanitizes metadata objects by masking sensitive tokens, secrets, and passwords.
 */
export function sanitizeMeta(obj: any, depth = 0): any {
  if (depth > 5) return "[MaxDepth]";
  if (!obj || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeMeta(item, depth + 1));
  }

  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = SENSITIVE_KEYS.some((s) => lowerKey.includes(s));

    if (isSensitive) {
      if (typeof value === "string") {
        if (value.length > 8) {
          sanitized[key] = `${value.substring(0, 4)}...[REDACTED]...${value.substring(value.length - 2)}`;
        } else {
          sanitized[key] = "[REDACTED]";
        }
      } else {
        sanitized[key] = "[REDACTED]";
      }
    } else if (value && typeof value === "object") {
      sanitized[key] = sanitizeMeta(value, depth + 1);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// In-memory circular buffer for quick retrieval via Admin API
class CircularBuffer<T> {
  private buffer: T[];
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
    this.buffer = [];
  }

  push(item: T): void {
    if (this.buffer.length >= this.maxSize) {
      this.buffer.shift();
    }
    this.buffer.push(item);
  }

  getAll(): T[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer = [];
  }

  size(): number {
    return this.buffer.length;
  }
}

export const memoryLogs = new CircularBuffer<LogEntry>(1000);
export const memoryErrors = new CircularBuffer<LogEntry>(250);

// File Streams for Persistence
const LOGS_DIR = path.resolve(process.cwd(), "logs");
let appLogStream: fs.WriteStream | null = null;
let errorLogStream: fs.WriteStream | null = null;

try {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
  appLogStream = fs.createWriteStream(path.join(LOGS_DIR, "app.log"), { flags: "a" });
  errorLogStream = fs.createWriteStream(path.join(LOGS_DIR, "error.log"), { flags: "a" });
} catch (err) {
  console.error("[Logger] Warning: Could not initialize log file streams:", err);
}

const CURRENT_MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

function formatConsole(entry: LogEntry): string {
  const time = entry.timestamp.split("T")[1].replace("Z", "");
  const mod = entry.module ? `[${entry.module}]` : "";
  const req = entry.reqId ? `(${entry.reqId.substring(0, 8)})` : "";
  const status = entry.statusCode ? ` ${entry.statusCode}` : "";
  const dur = entry.durationMs !== undefined ? ` ${entry.durationMs}ms` : "";

  let color = "\x1b[0m"; // Reset
  switch (entry.level) {
    case "debug":
      color = "\x1b[90m"; // Gray
      break;
    case "info":
      color = "\x1b[36m"; // Cyan
      break;
    case "warn":
      color = "\x1b[33m"; // Yellow
      break;
    case "error":
      color = "\x1b[31m"; // Red
      break;
    case "fatal":
      color = "\x1b[35m\x1b[1m"; // Bold Magenta
      break;
  }

  const levelTag = entry.level.toUpperCase().padEnd(5);
  let line = `${color}${time} ${levelTag}\x1b[0m ${mod} ${req}${entry.message}${status}${dur}`;

  if (entry.error?.stack) {
    line += `\n\x1b[31m${entry.error.stack}\x1b[0m`;
  }
  return line;
}

export class Logger {
  private moduleName?: string;
  private defaultContext?: Record<string, any>;

  constructor(moduleName?: string, defaultContext?: Record<string, any>) {
    this.moduleName = moduleName;
    this.defaultContext = defaultContext;
  }

  public child(context: { module?: string; reqId?: string; tenantId?: string; userId?: string }): Logger {
    return new Logger(context.module || this.moduleName, {
      ...this.defaultContext,
      ...context,
    });
  }

  private log(level: LogLevel, message: string, meta?: any, err?: any): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[CURRENT_MIN_LEVEL]) {
      return;
    }

    let errorObj: LogEntry["error"] = undefined;
    if (err) {
      if (err instanceof Error) {
        errorObj = {
          name: err.name,
          message: err.message,
          stack: err.stack,
          code: (err as any).code,
          details: (err as any).details || (err as any).response?.data,
        };
      } else if (typeof err === "object") {
        errorObj = {
          name: "CustomError",
          message: err.message || JSON.stringify(err),
          details: err,
        };
      } else {
        errorObj = {
          name: "StringError",
          message: String(err),
        };
      }
    }

    const context = this.defaultContext || {};
    const sanitizedMeta = meta ? sanitizeMeta(meta) : undefined;

    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
      level,
      module: this.moduleName || context.module,
      message,
      reqId: context.reqId,
      tenantId: context.tenantId,
      userId: context.userId,
      durationMs: meta?.durationMs,
      statusCode: meta?.statusCode,
      meta: sanitizedMeta,
      error: errorObj,
    };

    // 1. In-memory buffer for real-time dashboard
    memoryLogs.push(entry);
    if (level === "error" || level === "fatal") {
      memoryErrors.push(entry);
    }

    // 2. Format to JSON line for file persistence
    const jsonLine = JSON.stringify(entry) + "\n";
    if (appLogStream && appLogStream.writable) {
      appLogStream.write(jsonLine);
    }
    if ((level === "error" || level === "fatal") && errorLogStream && errorLogStream.writable) {
      errorLogStream.write(jsonLine);
    }

    // 3. Output formatted string to console
    const formatted = formatConsole(entry);
    if (level === "error" || level === "fatal") {
      console.error(formatted);
    } else if (level === "warn") {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }
  }

  debug(message: string, meta?: any): void {
    this.log("debug", message, meta);
  }

  info(message: string, meta?: any): void {
    this.log("info", message, meta);
  }

  warn(message: string, meta?: any, err?: any): void {
    this.log("warn", message, meta, err);
  }

  error(message: string, err?: any, meta?: any): void {
    this.log("error", message, meta, err);
  }

  fatal(message: string, err?: any, meta?: any): void {
    this.log("fatal", message, meta, err);
  }
}

export const logger = new Logger("app");
