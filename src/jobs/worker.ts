/**
 * The worker loop: claim one job, run its handler, record the outcome, repeat.
 *
 * Nothing here knows what any job does — handlers are registered by type — so sync, analysis, and
 * future producers share one execution, retry, and observability path.
 */
import type { Database } from '../db/driver';
import { workspaceScope, type WorkspaceScope } from '../db/scope';
import { PermanentError, RetryableError } from './errors';
import {
  claimNextJob,
  completeJob,
  failJob,
  reclaimStaleJobs,
  DEFAULT_STALE_LOCK_SECONDS,
} from './queue';
import type { JobPayloads, JobRecord, JobType } from './types';

export interface JobContext<T extends JobType = JobType> {
  db: Database;
  job: JobRecord;
  payload: JobPayloads[T];
  workspaceId: string;
  /** Workspace-pinned queryable; every read of workspace data goes through it. */
  scope: WorkspaceScope;
  log: (message: string, fields?: Record<string, unknown>) => void;
}

export type JobHandler<T extends JobType = JobType> = (ctx: JobContext<T>) => Promise<void>;

export type HandlerRegistry = Partial<{ [T in JobType]: JobHandler<T> }>;

export interface WorkerOptions {
  workerId?: string;
  /** Restrict this worker to a subset of job types. */
  types?: readonly JobType[];
  pollIntervalMs?: number;
  staleLockSeconds?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface JobOutcome {
  job: JobRecord;
  result: 'succeeded' | 'retrying' | 'failed';
  error?: unknown;
}

export class Worker {
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly staleLockSeconds: number;
  private readonly log: (message: string, fields?: Record<string, unknown>) => void;
  private running = false;
  private stopping = false;

  constructor(
    private readonly database: Database,
    private readonly handlers: HandlerRegistry,
    private readonly options: WorkerOptions = {},
  ) {
    this.workerId =
      options.workerId ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.staleLockSeconds = options.staleLockSeconds ?? DEFAULT_STALE_LOCK_SECONDS;
    this.log = options.log ?? (() => undefined);
  }

  /** Claim and run at most one job. Returns undefined when the queue has nothing runnable. */
  async runOnce(): Promise<JobOutcome | undefined> {
    const job = await claimNextJob(this.database, this.workerId, { types: this.options.types });
    if (!job) return undefined;

    const handler = this.handlers[job.type] as JobHandler | undefined;
    if (!handler) {
      await failJob(this.database, job, new PermanentError(`No handler for job type ${job.type}`));
      return { job, result: 'failed' };
    }

    try {
      await handler({
        db: this.database,
        job,
        payload: job.payload,
        workspaceId: job.workspaceId,
        scope: workspaceScope(this.database, job.workspaceId),
        log: (message, fields) => this.log(message, { job: job.id, type: job.type, ...fields }),
      });
      await completeJob(this.database, job.id);
      return { job, result: 'succeeded' };
    } catch (error) {
      if (error instanceof PermanentError) {
        // Skip the remaining attempts: nothing about waiting changes the outcome.
        await failJob(this.database, { ...job, attempts: job.maxAttempts }, error);
        this.log('job failed permanently', { job: job.id, type: job.type, error: String(error) });
        return { job, result: 'failed', error };
      }
      const retryAfterSeconds =
        error instanceof RetryableError ? error.retryAfterSeconds : undefined;
      const result = await failJob(this.database, job, error, { retryAfterSeconds });
      this.log(`job ${result}`, { job: job.id, type: job.type, error: String(error) });
      return { job, result, error };
    }
  }

  /** Drain every runnable job, then return. Used by tests and by one-shot invocations. */
  async drain(limit = 1000): Promise<JobOutcome[]> {
    const outcomes: JobOutcome[] = [];
    for (let i = 0; i < limit; i++) {
      const outcome = await this.runOnce();
      if (!outcome) break;
      outcomes.push(outcome);
    }
    return outcomes;
  }

  async start(): Promise<void> {
    this.running = true;
    this.stopping = false;
    this.log('worker started', { workerId: this.workerId });
    let sinceSweep = 0;
    while (!this.stopping) {
      // Reclaim before claiming, so a restart picks up work its predecessor was holding.
      if (sinceSweep <= 0) {
        const reclaimed = await reclaimStaleJobs(this.database, this.staleLockSeconds);
        if (reclaimed > 0) this.log('reclaimed stale jobs', { count: reclaimed });
        sinceSweep = 30;
      }
      sinceSweep--;

      let outcome: JobOutcome | undefined;
      try {
        outcome = await this.runOnce();
      } catch (error) {
        this.log('worker loop error', { error: String(error) });
      }
      if (!outcome) await sleep(this.pollIntervalMs);
    }
    this.running = false;
    this.log('worker stopped', { workerId: this.workerId });
  }

  stop(): void {
    this.stopping = true;
  }

  get isRunning(): boolean {
    return this.running;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
