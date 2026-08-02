/**
 * Database driver abstraction.
 *
 * Production runs against Postgres over `pg`. Tests run against an embedded Postgres (PGlite)
 * when no DATABASE_URL is present, so the suite needs no external service. Both speak the same
 * SQL; the abstraction exists only to hide connection management.
 */

export interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

export interface Queryable {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>>;
  /** Run a script that may contain several statements and takes no parameters. */
  exec(sql: string): Promise<void>;
}

/** A handle inside an open transaction. Passed explicitly so callers can enlist their own work. */
export interface Transaction extends Queryable {
  readonly isTransaction: true;
}

export interface Database extends Queryable {
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function queryOne<R>(
  db: Queryable,
  sql: string,
  params?: readonly unknown[],
): Promise<R | undefined> {
  const result = await db.query<R>(sql, params);
  return result.rows[0];
}

export async function queryExactlyOne<R>(
  db: Queryable,
  sql: string,
  params?: readonly unknown[],
): Promise<R> {
  const row = await queryOne<R>(db, sql, params);
  if (row === undefined) throw new Error('Expected exactly one row, got none');
  return row;
}
