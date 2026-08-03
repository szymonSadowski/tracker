/**
 * One pass of job execution (design D1).
 *
 * Every way the product executes queued work goes through here: the resident worker is this
 * operation in a loop, and a timer-driven endpoint is this operation with a budget. There is one
 * implementation rather than two that have to be kept equivalent.
 *
 * The order is fixed and not a caller's choice, because two of the three steps are easy to omit
 * and silent when omitted:
 *
 *   1. **Reclaim** — a job whose executor vanished is left `running` forever otherwise, and since
 *      a dedupe key collides while a job is pending *or* running, that also suppresses every later
 *      enqueue for the same subject. One interrupted job quietly stops a repository's syncs.
 *   2. **Tick** — `scheduler.ts` is the only thing that enqueues `workspace.schedule_syncs`, so a
 *      deployment that never ticks never runs periodic sync, while the on-demand button keeps
 *      working and hides it.
 *   3. **Execute** — claim and run until the queue is empty or the budget is spent.
 */
import type { Database } from '../db/driver';
import { DEFAULT_STALE_LOCK_SECONDS, reclaimStaleJobs } from './queue';
import {
  registerScheduledTasks,
  runDueScheduledTasks,
  type ScheduledTaskDefinition,
} from './scheduler';
import type { JobType } from './types';
import { Worker, type HandlerRegistry } from './worker';

/**
 * Held back from the budget so a pass never starts a job it cannot finish inside it. Jobs are
 * already bounded — backfill and history sync stop after a few pages — so declining to start
 * another one is enough, and no cancellation machinery is needed (design D3).
 */
export const DEFAULT_RESERVE_MS = 30_000;

export const DEFAULT_POLL_INTERVAL_MS = 1000;

export interface DrainOptions {
  /**
   * Wall-clock budget for the whole pass. Omitted means unbounded: run until the queue is empty,
   * which is what the resident worker wants.
   */
  budgetMs?: number;
  /** Overrides {@link DEFAULT_RESERVE_MS}. Ignored when there is no budget. */
  reserveMs?: number;
  /**
   * Scheduled tasks to register and evaluate. Omitted means this pass does not tick — correct for
   * a deployment that runs a separate scheduler process, wrong for one that does not.
   */
  scheduledTasks?: readonly ScheduledTaskDefinition[];
  staleLockSeconds?: number;
  workerId?: string;
  /** Restrict this pass to a subset of job types. */
  types?: readonly JobType[];
  /** Stop claiming after this many jobs, whatever the budget says. */
  maxJobs?: number;
  /** Checked between jobs; returning false stops the pass without abandoning the job in flight. */
  shouldContinue?: () => boolean;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** Test seam for the clock. */
  now?: () => number;
}

export interface DrainResult {
  reclaimed: number;
  scheduledTasksFired: number;
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
  /** True when the pass stopped because its budget ran out with work still runnable. */
  budgetExhausted: boolean;
}

function emptyResult(): DrainResult {
  return {
    reclaimed: 0,
    scheduledTasksFired: 0,
    claimed: 0,
    succeeded: 0,
    retried: 0,
    failed: 0,
    budgetExhausted: false,
  };
}

export async function runDrain(
  database: Database,
  handlers: HandlerRegistry,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const log = options.log ?? (() => undefined);
  const shouldContinue = options.shouldContinue ?? (() => true);
  const result = emptyResult();

  const worker = new Worker(database, handlers, {
    workerId: options.workerId,
    types: options.types,
    log: options.log,
  });

  // 1. Recovery before claiming, so this pass picks up work its predecessor was holding.
  result.reclaimed = await reclaimStaleJobs(
    database,
    options.staleLockSeconds ?? DEFAULT_STALE_LOCK_SECONDS,
  );
  if (result.reclaimed > 0) log('reclaimed stale jobs', { count: result.reclaimed });

  // 2. Due scheduled work. Registration is an idempotent upsert, so a deployment whose scheduler
  //    process has never run still has rows to evaluate.
  if (options.scheduledTasks && options.scheduledTasks.length > 0) {
    await registerScheduledTasks(database, options.scheduledTasks);
    for (const fired of await runDueScheduledTasks(database, options.scheduledTasks)) {
      result.scheduledTasksFired++;
      log('scheduled task fired', { ...fired });
    }
  }

  // 3. Execute. The budget is checked between jobs and never interrupts one in flight.
  const deadline =
    options.budgetMs === undefined
      ? undefined
      : startedAt + Math.max(0, options.budgetMs - (options.reserveMs ?? DEFAULT_RESERVE_MS));
  const maxJobs = options.maxJobs ?? Number.POSITIVE_INFINITY;

  while (result.claimed < maxJobs && shouldContinue()) {
    if (deadline !== undefined && now() >= deadline) {
      result.budgetExhausted = true;
      break;
    }

    const outcome = await worker.runOnce();
    if (!outcome) break;

    result.claimed++;
    if (outcome.result === 'succeeded') result.succeeded++;
    else if (outcome.result === 'retrying') result.retried++;
    else result.failed++;
  }

  return result;
}

export interface ResidentDrainOptions extends DrainOptions {
  /** How long to wait after a pass that found nothing. */
  pollIntervalMs?: number;
}

/**
 * The resident worker: `runDrain` in a loop, sleeping only when there was nothing to do.
 *
 * `shouldContinue` is checked between jobs as well as between passes, so a stop signal takes
 * effect after the job in flight rather than after the whole queue.
 */
export async function runResidentDrain(
  database: Database,
  handlers: HandlerRegistry,
  options: ResidentDrainOptions = {},
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const log = options.log ?? (() => undefined);
  const shouldContinue = options.shouldContinue ?? (() => true);

  while (shouldContinue()) {
    let claimed = 0;
    try {
      claimed = (await runDrain(database, handlers, options)).claimed;
    } catch (error) {
      // A pass that throws must not kill the process: the next one retries, and any job it was
      // holding is recovered by the reclaim at the top of that pass.
      log('drain pass error', { error: String(error) });
    }
    if (claimed === 0 && shouldContinue()) await sleep(pollIntervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
