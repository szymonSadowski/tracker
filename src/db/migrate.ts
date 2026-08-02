/**
 * Migration runner: ordered `.sql` files applied once each, recorded in `schema_migrations`.
 *
 * Kept deliberately small — the schema is plain SQL so it can be read, reviewed, and applied by
 * a DBA without the application present.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './driver';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

export interface Migration {
  name: string;
  sql: string;
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ name: file, sql: readFileSync(join(dir, file), 'utf8') }));
}

export async function migrate(database: Database, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await database.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const applied = new Set(
    (await database.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
      (row) => row.name,
    ),
  );

  const ran: string[] = [];
  for (const migration of loadMigrations(dir)) {
    if (applied.has(migration.name)) continue;
    await database.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [migration.name]);
    });
    ran.push(migration.name);
  }
  return ran;
}
