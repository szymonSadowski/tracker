/**
 * The scheduled trigger. It enqueues due periodic work and never executes it, so a slow sync
 * cannot delay the schedule and every run gets the queue's retry and observability behaviour
 * (design.md D11).
 */
import { syncDefaults } from '../config/env';
import type { Database, Queryable } from '../db/driver';
import { enqueue } from './queue';

export interface ScheduledTaskDefinition {
  name: string;
  intervalSeconds: number;
  /** Enqueue the work this task represents. Returns how many jobs it created. */
  enqueue: (db: Queryable) => Promise<number>;
}

/**
 * Periodic sync: one `workspace.schedule_syncs` job per active workspace, which in turn enqueues
 * per-repository incremental syncs. Installations needing attention are excluded — GitHub has
 * already told us their credentials do not work.
 */
export const syncScheduleTask = (intervalSeconds: number): ScheduledTaskDefinition => ({
  name: 'sync.workspaces',
  intervalSeconds,
  enqueue: async (db) => {
    const { rows } = await db.query<{ workspace_id: string }>(
      `SELECT w.id AS workspace_id
         FROM workspaces w
         JOIN installations i ON i.workspace_id = w.id
        WHERE w.deleted_at IS NULL AND i.status = 'active'`,
    );
    let created = 0;
    for (const row of rows) {
      const job = await enqueue(db, {
        workspaceId: row.workspace_id,
        type: 'workspace.schedule_syncs',
        payload: {},
        dedupeKey: 'schedule_syncs',
      });
      if (job) created++;
    }
    return created;
  },
});

/**
 * The scheduled tasks this deployment runs.
 *
 * One definition list, shared by the scheduler process and by any drain pass that ticks, so a
 * deployment cannot end up with two disagreeing ideas of what is scheduled — or, worse, with a
 * topology that ticks nothing at all.
 */
export function defaultScheduledTasks(): ScheduledTaskDefinition[] {
  return [syncScheduleTask(syncDefaults().syncIntervalMinutes * 60)];
}

export async function registerScheduledTasks(
  db: Queryable,
  tasks: readonly ScheduledTaskDefinition[],
): Promise<void> {
  for (const task of tasks) {
    await db.query(
      `INSERT INTO scheduled_tasks (name, interval_seconds)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET interval_seconds = EXCLUDED.interval_seconds`,
      [task.name, task.intervalSeconds],
    );
  }
}

/**
 * Run every task whose next_run_at has passed. The due check and the advance happen in one
 * transaction with a row lock, so two schedulers cannot both fire the same tick.
 */
export async function runDueScheduledTasks(
  database: Database,
  tasks: readonly ScheduledTaskDefinition[],
): Promise<{ name: string; enqueued: number }[]> {
  const results: { name: string; enqueued: number }[] = [];
  for (const task of tasks) {
    const fired = await database.transaction(async (tx) => {
      const { rows } = await tx.query<{ name: string }>(
        `UPDATE scheduled_tasks
            SET next_run_at = now() + make_interval(secs => interval_seconds::double precision),
                last_run_at = now()
          WHERE name = (
            SELECT name FROM scheduled_tasks
             WHERE name = $1 AND enabled AND next_run_at <= now()
             FOR UPDATE SKIP LOCKED
          )
          RETURNING name`,
        [task.name],
      );
      if (rows.length === 0) return undefined;
      return task.enqueue(tx);
    });
    if (fired !== undefined) results.push({ name: task.name, enqueued: fired });
  }
  return results;
}
