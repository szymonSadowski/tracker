/**
 * Database-backed job queue (design.md D11).
 *
 * Enqueueing takes a `Queryable`, so a caller inside a transaction passes their transaction and
 * the job commits with the data that justifies it — there is no window in which normalized rows
 * exist but the analysis job for them was lost.
 */
import type { Database, Queryable } from '../db/driver';
import type { JobPayloads, JobRecord, JobState, JobType } from './types';

/** First retry after 10s, doubling, capped at an hour. */
export const RETRY_BASE_SECONDS = 10;
export const RETRY_MAX_SECONDS = 3600;

export function backoffSeconds(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * 2 ** exponent);
}

/** A running job whose worker has not touched it for this long is considered lost. */
export const DEFAULT_STALE_LOCK_SECONDS = 300;

interface JobRow {
  id: string;
  workspace_id: string;
  type: JobType;
  payload: unknown;
  state: JobState;
  attempts: number;
  max_attempts: number;
  priority: number;
  run_after: Date;
  locked_at: Date | null;
  locked_by: string | null;
  last_error: string | null;
  dedupe_key: string | null;
  created_at: Date;
  finished_at: Date | null;
}

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type,
    payload: (typeof row.payload === 'string'
      ? JSON.parse(row.payload)
      : row.payload) as JobPayloads[JobType],
    state: row.state,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    priority: row.priority,
    runAfter: row.run_after,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    lastError: row.last_error,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

export interface EnqueueOptions<T extends JobType> {
  workspaceId: string;
  type: T;
  payload: JobPayloads[T];
  runAfter?: Date;
  priority?: number;
  maxAttempts?: number;
  /**
   * Collapses redundant work: while a job with the same key is pending or running, enqueueing
   * again is a no-op and returns undefined.
   */
  dedupeKey?: string;
}

export async function enqueue<T extends JobType>(
  db: Queryable,
  options: EnqueueOptions<T>,
): Promise<JobRecord | undefined> {
  const { rows } = await db.query<JobRow>(
    `INSERT INTO jobs (workspace_id, type, payload, run_after, priority, max_attempts, dedupe_key)
     VALUES ($1, $2, $3::jsonb, COALESCE($4, now()), COALESCE($5, 100), COALESCE($6, 5), $7)
     ON CONFLICT (workspace_id, dedupe_key)
       WHERE dedupe_key IS NOT NULL AND state IN ('pending', 'running')
       DO NOTHING
     RETURNING *`,
    [
      options.workspaceId,
      options.type,
      JSON.stringify(options.payload ?? {}),
      options.runAfter ?? null,
      options.priority ?? null,
      options.maxAttempts ?? null,
      options.dedupeKey ?? null,
    ],
  );
  const row = rows[0];
  return row ? toRecord(row) : undefined;
}

/**
 * Claim the next runnable job. `FOR UPDATE SKIP LOCKED` is what keeps two workers off the same
 * row; the claim also increments attempts so a worker that dies mid-run cannot retry forever.
 */
export async function claimNextJob(
  db: Queryable,
  workerId: string,
  options: { types?: readonly JobType[] } = {},
): Promise<JobRecord | undefined> {
  const { rows } = await db.query<JobRow>(
    `UPDATE jobs
        SET state = 'running',
            locked_at = now(),
            locked_by = $1,
            attempts = attempts + 1,
            updated_at = now()
      WHERE id = (
        SELECT id FROM jobs
         WHERE state = 'pending'
           AND run_after <= now()
           AND ($2::text[] IS NULL OR type = ANY($2::text[]))
         ORDER BY priority ASC, run_after ASC, created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [workerId, options.types ? [...options.types] : null],
  );
  const row = rows[0];
  return row ? toRecord(row) : undefined;
}

export async function completeJob(db: Queryable, jobId: string): Promise<void> {
  await db.query(
    `UPDATE jobs
        SET state = 'succeeded', finished_at = now(), updated_at = now(),
            locked_at = NULL, locked_by = NULL, last_error = NULL
      WHERE id = $1`,
    [jobId],
  );
}

/**
 * Record a failure: retry with backoff until the attempt cap, then park the job in a terminal
 * failed state so it stops consuming worker time and becomes visible as a problem.
 */
export async function failJob(
  db: Queryable,
  job: Pick<JobRecord, 'id' | 'attempts' | 'maxAttempts'>,
  error: unknown,
  overrides: { retryAfterSeconds?: number } = {},
): Promise<'retrying' | 'failed'> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const exhausted = job.attempts >= job.maxAttempts;
  if (exhausted) {
    await db.query(
      `UPDATE jobs
          SET state = 'failed', last_error = $2, finished_at = now(), updated_at = now(),
              locked_at = NULL, locked_by = NULL
        WHERE id = $1`,
      [job.id, message],
    );
    return 'failed';
  }
  const delay = overrides.retryAfterSeconds ?? backoffSeconds(job.attempts);
  await db.query(
    `UPDATE jobs
        SET state = 'pending', last_error = $2, updated_at = now(),
            run_after = now() + make_interval(secs => $3::double precision),
            locked_at = NULL, locked_by = NULL
      WHERE id = $1`,
    [job.id, message, delay],
  );
  return 'retrying';
}

/**
 * Return jobs whose worker vanished to the pending pool. Attempts are not rewound: a job that
 * repeatedly kills its worker still exhausts its budget rather than looping forever.
 */
export async function reclaimStaleJobs(
  db: Queryable,
  staleAfterSeconds: number = DEFAULT_STALE_LOCK_SECONDS,
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE jobs
        SET state = 'pending', locked_at = NULL, locked_by = NULL, updated_at = now(),
            last_error = COALESCE(last_error, 'reclaimed after worker went away')
      WHERE state = 'running'
        AND locked_at < now() - make_interval(secs => $1::double precision)`,
    [staleAfterSeconds],
  );
  return rowCount;
}

/** Stop pending work for a workspace — used when an installation is removed or suspended. */
export async function cancelPendingJobs(
  db: Queryable,
  workspaceId: string,
  reason: string,
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE jobs
        SET state = 'cancelled', last_error = $2, finished_at = now(), updated_at = now()
      WHERE workspace_id = $1 AND state = 'pending'`,
    [workspaceId, reason],
  );
  return rowCount;
}

export async function getJob(db: Queryable, jobId: string): Promise<JobRecord | undefined> {
  const { rows } = await db.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [jobId]);
  const row = rows[0];
  return row ? toRecord(row) : undefined;
}

export async function countJobs(
  db: Queryable,
  where: { workspaceId?: string; state?: JobState; type?: JobType } = {},
): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM jobs
      WHERE ($1::uuid IS NULL OR workspace_id = $1)
        AND ($2::text IS NULL OR state = $2)
        AND ($3::text IS NULL OR type = $3)`,
    [where.workspaceId ?? null, where.state ?? null, where.type ?? null],
  );
  return rows[0]!.count;
}

/** Convenience for callers outside a transaction. */
export function enqueueOn<T extends JobType>(
  database: Database,
  options: EnqueueOptions<T>,
): Promise<JobRecord | undefined> {
  return enqueue(database, options);
}
