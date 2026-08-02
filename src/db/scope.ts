/**
 * Workspace-scoped data access (design.md D9, spec: tenancy-and-teams).
 *
 * Every workspace-scoped table carries `workspace_id`, and every read of one goes through a
 * `WorkspaceScope`. Statements name the scope with the `:workspace` marker, which this module
 * substitutes with a bound parameter. A statement that touches a scoped table without the marker
 * is rejected before it reaches the database — the isolation is structural, not a convention
 * that each query author has to remember.
 */
import type { Database, Queryable, QueryResult, Transaction } from './driver';

/**
 * Tables whose rows belong to exactly one workspace. `schema_migrations`, `users`, and `sessions`
 * are deliberately absent: they are global. A test asserts this list matches the columns actually
 * present in the schema, so a new scoped table cannot silently escape enforcement.
 */
export const WORKSPACE_SCOPED_TABLES = [
  'jobs',
  'installations',
  'repositories',
  'github_raw_events',
  'contributors',
  'pull_requests',
  'pr_reviews',
  'pr_commits',
  'pr_events',
  'pr_analysis',
  'sync_runs',
  'teams',
  'team_members',
  'workspace_members',
  'repository_permissions',
] as const;

export type WorkspaceScopedTable = (typeof WORKSPACE_SCOPED_TABLES)[number];

export class MissingWorkspaceScopeError extends Error {
  constructor(table: string) {
    super(
      `Query touches workspace-scoped table "${table}" without a :workspace marker. ` +
        'Data access must be scoped to one workspace.',
    );
    this.name = 'MissingWorkspaceScopeError';
  }
}

const SQL_STRINGS_AND_COMMENTS = /'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g;

/** Strip literals and comments so table detection cannot be fooled by text content. */
function sqlSkeleton(sql: string): string {
  return sql.replace(SQL_STRINGS_AND_COMMENTS, ' ');
}

export function scopedTablesReferenced(sql: string): WorkspaceScopedTable[] {
  const skeleton = sqlSkeleton(sql);
  return WORKSPACE_SCOPED_TABLES.filter((table) =>
    new RegExp(`\\b${table}\\b`, 'i').test(skeleton),
  );
}

export function assertWorkspaceScoped(sql: string): void {
  const referenced = scopedTablesReferenced(sql);
  if (referenced.length === 0) return;
  if (!sqlSkeleton(sql).includes(':workspace')) {
    throw new MissingWorkspaceScopeError(referenced[0]!);
  }
}

/**
 * Replace every `:workspace` marker with a positional parameter, appended after the caller's own
 * parameters so their numbering is untouched.
 */
export function bindWorkspace(
  sql: string,
  params: readonly unknown[],
  workspaceId: string,
): { sql: string; params: unknown[] } {
  if (!sql.includes(':workspace')) return { sql, params: [...params] };
  const placeholder = `$${params.length + 1}`;
  return {
    sql: sql.replaceAll(':workspace', placeholder),
    params: [...params, workspaceId],
  };
}

/** A queryable pinned to one workspace. */
export class WorkspaceScope implements Queryable {
  constructor(
    private readonly inner: Queryable,
    readonly workspaceId: string,
  ) {}

  async query<R>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    assertWorkspaceScoped(sql);
    const bound = bindWorkspace(sql, params, this.workspaceId);
    return this.inner.query<R>(bound.sql, bound.params);
  }

  /** Multi-statement scripts cannot carry bound parameters, so they may not touch scoped data. */
  async exec(sql: string): Promise<void> {
    const referenced = scopedTablesReferenced(sql);
    if (referenced.length > 0) throw new MissingWorkspaceScopeError(referenced[0]!);
    await this.inner.exec(sql);
  }

  /** A scope over an open transaction, for writes that must commit with the caller's work. */
  withQueryable(inner: Queryable): WorkspaceScope {
    return new WorkspaceScope(inner, this.workspaceId);
  }
}

export function workspaceScope(inner: Queryable, workspaceId: string): WorkspaceScope {
  if (!workspaceId) throw new Error('A workspace id is required to access workspace-scoped data');
  return new WorkspaceScope(inner, workspaceId);
}

/** Run a transaction whose statements are all scoped to one workspace. */
export function scopedTransaction<T>(
  database: Database,
  workspaceId: string,
  fn: (scope: WorkspaceScope, tx: Transaction) => Promise<T>,
): Promise<T> {
  return database.transaction((tx) => fn(workspaceScope(tx, workspaceId), tx));
}
