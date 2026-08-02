import pg from 'pg';
import type { Database, QueryResult, Transaction } from './driver';

// `bigint` and `numeric` come back as strings by default; every such column in this schema fits
// comfortably in a JS number, and reading them as strings would leak into every metric.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number.parseFloat(value));

class PgTransaction implements Transaction {
  readonly isTransaction = true as const;

  constructor(private readonly client: pg.PoolClient) {}

  async query<R>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    const result = await this.client.query(sql, params as unknown[]);
    return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }
}

export class PostgresDatabase implements Database {
  private readonly pool: pg.Pool;

  constructor(connectionString: string, max = 10) {
    this.pool = new pg.Pool({ connectionString, max });
  }

  async query<R>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    const result = await this.pool.query(sql, params as unknown[]);
    return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(new PgTransaction(client));
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
