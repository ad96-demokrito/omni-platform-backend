const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

/**
 * An Error carrying an HTTP status; `middleware/error-handler.ts` turns it into `{ error }`.
 * For 5xx the handler normally hides the message ("Internal server error"). Pass `expose: true` only for
 * messages written to be shown to the customer (for example "payments are not available right now").
 */
export function httpError(
  statusCode: number,
  message: string,
  options: {
    expose?: boolean;
    /** Machine-readable code returned as `code` (for example "PLAN_LIMIT_REACHED"). */
    code?: string;
    /** Extra fields returned next to `error`/`code` (for example `{ metric, limit, used }`). Customer-safe only. */
    details?: Record<string, unknown>;
  } = {}
): Error {
  return Object.assign(new Error(message), {
    statusCode,
    ...(options.expose ? { expose: true } : {}),
    ...(options.code ? { code: options.code } : {}),
    ...(options.details ? { details: options.details } : {}),
  });
}
