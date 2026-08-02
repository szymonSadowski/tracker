/**
 * Database fixtures for tests.
 *
 * Uses the Postgres server at TEST_DATABASE_URL when one is configured, and an embedded Postgres
 * otherwise. `freshDatabase()` returns a migrated, empty database; `realPostgresOnly()` lets a
 * test that needs true connection concurrency skip cleanly on the embedded engine.
 */
import { afterAll, beforeEach } from 'vitest';
import type { Database } from '../../src/db/driver';
import { migrate } from '../../src/db/migrate';
import { PostgresDatabase } from '../../src/db/pg';
import { setDatabase } from '../../src/db/client';
import { PGliteDatabase } from './pglite';

const TABLES = [
  'pr_analysis',
  'pr_events',
  'pr_commits',
  'pr_reviews',
  'pull_requests',
  'sync_runs',
  'github_raw_events',
  'team_members',
  'teams',
  'repository_permissions',
  'workspace_members',
  'sessions',
  'users',
  'contributors',
  'repositories',
  'installations',
  'workspaces',
  'jobs',
  'scheduled_tasks',
];

export function testDatabaseUrl(): string | undefined {
  return process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
}

export function usingRealPostgres(): boolean {
  return testDatabaseUrl() !== undefined;
}

/** Skip a test that depends on multiple simultaneous connections when running embedded. */
export function realPostgresOnly(): boolean {
  return !usingRealPostgres();
}

async function create(): Promise<Database> {
  const url = testDatabaseUrl();
  const database = url ? new PostgresDatabase(url) : await PGliteDatabase.create();
  await migrate(database);
  return database;
}

export async function truncateAll(database: Database): Promise<void> {
  await database.exec(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

/**
 * A migrated database, shared across the tests in a file and emptied before each one. Also
 * installed as the process-wide handle so code under test that calls `db()` uses it.
 */
export function databaseFixture(): () => Database {
  let database: Database | undefined;

  const ready = create().then((created) => {
    database = created;
    setDatabase(created);
    return created;
  });

  beforeEach(async () => {
    const created = await ready;
    setDatabase(created);
    await truncateAll(created);
  });

  afterAll(async () => {
    const created = await ready;
    setDatabase(undefined);
    await created.close();
  });

  return () => {
    if (!database) throw new Error('Database not ready — call inside a test, not at module scope');
    return database;
  };
}

/** A one-off migrated database the caller owns and closes. */
export async function freshDatabase(): Promise<Database> {
  return create();
}
