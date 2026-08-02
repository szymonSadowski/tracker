/**
 * Scheduler entrypoint: `npm run scheduler`. Ticks once a minute and enqueues due work; it never
 * runs the work itself. Safe to run alongside another scheduler — due tasks are claimed with a
 * row lock.
 */
import { closeDatabase, db } from '../db/client';
import { syncDefaults } from '../config/env';
import { registerScheduledTasks, runDueScheduledTasks, syncScheduleTask } from './scheduler';

const tasks = [syncScheduleTask(syncDefaults().syncIntervalMinutes * 60)];
await registerScheduledTasks(db(), tasks);

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

while (!stopping) {
  const fired = await runDueScheduledTasks(db(), tasks);
  for (const result of fired) {
    console.log(JSON.stringify({ message: 'scheduled task fired', ...result }));
  }
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}

await closeDatabase();
