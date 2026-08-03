/** Worker process entrypoint: `npm run worker`. */
import { closeDatabase, executionDb } from '../db/client';
import { runResidentDrain } from './drain';
import { handlers } from './handlers/index';

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(JSON.stringify({ message: 'shutting down', signal }));
    stopping = true;
  });
}

const log = (message: string, fields?: Record<string, unknown>) =>
  console.log(JSON.stringify({ message, ...fields }));

log('worker started');
// No `scheduledTasks`: the scheduler process owns the tick in this topology, as it did before.
await runResidentDrain(executionDb(), handlers, { shouldContinue: () => !stopping, log });
log('worker stopped');

await closeDatabase();
