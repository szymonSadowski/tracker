/** Worker process entrypoint: `npm run worker`. */
import { closeDatabase, db } from '../db/client';
import { handlers } from './handlers/index';
import { Worker } from './worker';

const worker = new Worker(db(), handlers, {
  log: (message, fields) => console.log(JSON.stringify({ message, ...fields })),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(JSON.stringify({ message: 'shutting down', signal }));
    worker.stop();
  });
}

await worker.start();
await closeDatabase();
