/**
 * Embedded-Postgres adapter used by the test suite when no DATABASE_URL is configured, so the
 * suite runs with no external service. It is real Postgres (compiled to WASM), so schema and SQL
 * behaviour match production; the one difference that matters is that it serves a single
 * connection, which is why genuinely concurrent tests are gated on a real server.
 */
import { PGlite } from '@electric-sql/pglite';
import type { Database, QueryResult, Transaction } from '../../src/db/driver';

type PGliteQueryable = {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
};

class PGliteQueryableAdapter implements Transaction {
  readonly isTransaction = true as const;

  constructor(protected readonly inner: PGliteQueryable) {}

  async query<R>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    const result = await this.inner.query<R>(sql, params as unknown[]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.inner.exec(sql);
  }
}

export class PGliteDatabase extends PGliteQueryableAdapter implements Database {
  constructor(private readonly pglite: PGlite) {
    super(pglite as unknown as PGliteQueryable);
  }

  static async create(): Promise<PGliteDatabase> {
    return new PGliteDatabase(await PGlite.create());
  }

  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.pglite.transaction(async (tx) =>
      fn(new PGliteQueryableAdapter(tx as unknown as PGliteQueryable)),
    ) as Promise<T>;
  }

  async close(): Promise<void> {
    await this.pglite.close();
  }
}
