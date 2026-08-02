import type { Database } from './driver';
import { PostgresDatabase } from './pg';

let instance: Database | undefined;

/** The process-wide database handle. */
export function db(): Database {
  if (!instance) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Missing required environment variable DATABASE_URL');
    instance = new PostgresDatabase(url);
  }
  return instance;
}

/** Test seam: run against a caller-supplied database (embedded Postgres, a fixture, …). */
export function setDatabase(next: Database | undefined): void {
  instance = next;
}

export async function closeDatabase(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = undefined;
  }
}
