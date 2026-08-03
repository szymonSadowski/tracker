import type { Database } from './driver';
import { PostgresDatabase } from './pg';

let instance: Database | undefined;
let executionInstance: Database | undefined;

/** The process-wide database handle. */
export function db(): Database {
  if (!instance) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('Missing required environment variable DATABASE_URL');
    instance = new PostgresDatabase(url);
  }
  return instance;
}

/**
 * A direct (unpooled) connection string, when the deployment has one.
 *
 * `DATABASE_URL_UNPOOLED` is the name Vercel's Neon integration provisions and keeps in sync
 * through a credential rotation, so it is read as a fallback: a project wired up that way needs no
 * manual configuration, and nothing goes stale when the password changes.
 */
export function directDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL_UNPOOLED;
}

/**
 * The handle job execution uses (design D5).
 *
 * On a serverless deployment the request path wants a pooled endpoint, while a drain is a burst of
 * sequential work better served by a direct connection. With no direct URL configured — which is
 * every container deployment — this is exactly `db()` and nothing changes.
 *
 * A handle installed by `setDatabase` always wins, so tests run against one database.
 */
export function executionDb(): Database {
  if (instance) return instance;
  const direct = directDatabaseUrl();
  if (!direct) return db();
  if (!executionInstance) executionInstance = new PostgresDatabase(direct);
  return executionInstance;
}

/** Test seam: run against a caller-supplied database (embedded Postgres, a fixture, …). */
export function setDatabase(next: Database | undefined): void {
  instance = next;
}

export async function closeDatabase(): Promise<void> {
  if (executionInstance) {
    await executionInstance.close();
    executionInstance = undefined;
  }
  if (instance) {
    await instance.close();
    instance = undefined;
  }
}
