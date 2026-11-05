/**
 * In-memory heartbeat of the drip scheduler (see the setInterval in index.ts), so the campaign
 * page can show whether it is alive instead of leaving "pending" unexplained. It is per process
 * and resets on restart, which is fine for a single API instance; it holds timestamps, counts and
 * an error message only — never recipient data.
 */
export interface DripSchedulerStatus {
  intervalMs: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastProcessed: number;
  lastFailed: number;
}

const status: DripSchedulerStatus = {
  intervalMs: 0,
  lastRunAt: null,
  lastSuccessAt: null,
  lastError: null,
  lastProcessed: 0,
  lastFailed: 0,
};

export function initDripSchedulerStatus(intervalMs: number): void {
  status.intervalMs = intervalMs;
}

export function recordDripRunSuccess(result: { processed: number; failed: number }): void {
  const now = new Date().toISOString();
  status.lastRunAt = now;
  status.lastSuccessAt = now;
  status.lastError = null;
  status.lastProcessed = result.processed;
  status.lastFailed = result.failed;
}

export function recordDripRunError(err: unknown): void {
  status.lastRunAt = new Date().toISOString();
  status.lastError = err instanceof Error ? err.message : String(err);
}

export function getDripSchedulerStatus(): DripSchedulerStatus {
  return { ...status };
}
