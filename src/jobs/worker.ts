/**
 * Executing one job: claim it, run its handler, record the outcome.
 *
 * Nothing here knows what any job does — handlers are registered by type — so sync, analysis, and
 * future producers share one execution, retry, and observability path.
 *
 * This module deliberately offers no way to run *many* jobs. Looping over `runOnce` without also
 * recovering abandoned jobs and firing due scheduled tasks produces a deployment that works until
 * something is interrupted and then fails silently, so the multi-job entrypoint lives in
 * `drain.ts`, where those steps cannot be skipped (design D2).
 */
import type { Database } from '../db/driver';
import { workspaceScope, type WorkspaceScope } from '../db/scope';
import { PermanentError, RetryableError } from './errors';
import { claimNextJob, completeJob, failJob } from './queue';
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
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface JobOutcome {
  job: JobRecord;
  result: 'succeeded' | 'retrying' | 'failed';
  error?: unknown;
}

export class Worker {
  private readonly workerId: string;
  private readonly log: (message: string, fields?: Record<string, unknown>) => void;

  constructor(
    private readonly database: Database,
    private readonly handlers: HandlerRegistry,
    private readonly options: WorkerOptions = {},
  ) {
    this.workerId =
      options.workerId ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
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

}
