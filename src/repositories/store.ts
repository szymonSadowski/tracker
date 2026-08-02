/** Repository records and their sync bookkeeping (spec: github-data-sync). */
import type { Queryable } from '../db/driver';

export type BackfillState = 'pending' | 'in_progress' | 'complete' | 'failed';

export interface RepositoryRecord {
  id: string;
  workspaceId: string;
  nodeId: string;
  githubRepoId: number | null;
  ownerLogin: string;
  name: string;
  fullName: string;
  isPrivate: boolean;
  inScope: boolean;
  backfillState: BackfillState;
  backfillCursor: string | null;
  backfillWindowStart: Date | null;
  backfillCompletedAt: Date | null;
  lastSyncAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  syncedThrough: Date | null;
}

interface RepositoryRow {
  id: string;
  workspace_id: string;
  node_id: string;
  github_repo_id: number | null;
  owner_login: string;
  name: string;
  full_name: string;
  is_private: boolean;
  in_scope: boolean;
  backfill_state: BackfillState;
  backfill_cursor: string | null;
  backfill_window_start: Date | null;
  backfill_completed_at: Date | null;
  last_sync_at: Date | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  last_error: string | null;
  consecutive_failures: number;
  synced_through: Date | null;
}

export function toRepository(row: RepositoryRow): RepositoryRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    nodeId: row.node_id,
    githubRepoId: row.github_repo_id,
    ownerLogin: row.owner_login,
    name: row.name,
    fullName: row.full_name,
    isPrivate: row.is_private,
    inScope: row.in_scope,
    backfillState: row.backfill_state,
    backfillCursor: row.backfill_cursor,
    backfillWindowStart: row.backfill_window_start,
    backfillCompletedAt: row.backfill_completed_at,
    lastSyncAt: row.last_sync_at,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
    syncedThrough: row.synced_through,
  };
}

export interface RepositoryInput {
  nodeId: string;
  githubRepoId?: number;
  ownerLogin: string;
  name: string;
  isPrivate?: boolean;
  defaultBranch?: string;
}

/**
 * Insert or update by node id: a rename updates the name on the existing row rather than creating
 * a second repository, and previously ingested pull requests stay attached to it
 * (spec: github-app-installation).
 */
export async function upsertRepository(
  db: Queryable,
  workspaceId: string,
  input: RepositoryInput,
): Promise<{ repository: RepositoryRecord; created: boolean; renamedFrom?: string }> {
  const existing = await findRepositoryByNodeId(db, workspaceId, input.nodeId);
  const fullName = `${input.ownerLogin}/${input.name}`;
  const { rows } = await db.query<RepositoryRow>(
    `INSERT INTO repositories
       (workspace_id, node_id, github_repo_id, owner_login, name, full_name, is_private,
        default_branch, in_scope, removed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NULL)
     ON CONFLICT (workspace_id, node_id) DO UPDATE
       SET github_repo_id = COALESCE(EXCLUDED.github_repo_id, repositories.github_repo_id),
           owner_login = EXCLUDED.owner_login,
           name = EXCLUDED.name,
           full_name = EXCLUDED.full_name,
           is_private = EXCLUDED.is_private,
           default_branch = COALESCE(EXCLUDED.default_branch, repositories.default_branch),
           in_scope = true,
           removed_at = NULL,
           updated_at = now()
     RETURNING *`,
    [
      workspaceId,
      input.nodeId,
      input.githubRepoId ?? null,
      input.ownerLogin,
      input.name,
      fullName,
      input.isPrivate ?? true,
      input.defaultBranch ?? null,
    ],
  );
  const repository = toRepository(rows[0]!);
  return {
    repository,
    created: existing === undefined,
    renamedFrom: existing && existing.fullName !== fullName ? existing.fullName : undefined,
  };
}

export async function findRepositoryByNodeId(
  db: Queryable,
  workspaceId: string,
  nodeId: string,
): Promise<RepositoryRecord | undefined> {
  const { rows } = await db.query<RepositoryRow>(
    'SELECT * FROM repositories WHERE workspace_id = $1 AND node_id = $2',
    [workspaceId, nodeId],
  );
  return rows[0] ? toRepository(rows[0]) : undefined;
}

export async function getRepository(
  db: Queryable,
  repositoryId: string,
): Promise<RepositoryRecord | undefined> {
  const { rows } = await db.query<RepositoryRow>('SELECT * FROM repositories WHERE id = $1', [
    repositoryId,
  ]);
  return rows[0] ? toRepository(rows[0]) : undefined;
}

export async function listRepositories(
  db: Queryable,
  workspaceId: string,
  options: { inScopeOnly?: boolean } = {},
): Promise<RepositoryRecord[]> {
  const { rows } = await db.query<RepositoryRow>(
    `SELECT * FROM repositories
      WHERE workspace_id = $1 AND ($2::boolean IS NOT TRUE OR in_scope)
      ORDER BY full_name`,
    [workspaceId, options.inScopeOnly ?? false],
  );
  return rows.map(toRepository);
}

/** Deselected: keeps every row it has ingested, leaves every aggregate. */
export async function deselectRepository(
  db: Queryable,
  workspaceId: string,
  repositoryId: string,
): Promise<void> {
  await db.query(
    `UPDATE repositories SET in_scope = false, removed_at = now(), updated_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, repositoryId],
  );
}

export async function markBackfillStarted(
  db: Queryable,
  repositoryId: string,
  windowStart: Date,
): Promise<void> {
  await db.query(
    `UPDATE repositories
        SET backfill_state = 'in_progress',
            backfill_window_start = COALESCE(backfill_window_start, $2),
            backfill_started_at = COALESCE(backfill_started_at, now()),
            updated_at = now()
      WHERE id = $1`,
    [repositoryId, windowStart],
  );
}

export async function recordBackfillProgress(
  db: Queryable,
  repositoryId: string,
  cursor: string | null,
): Promise<void> {
  await db.query('UPDATE repositories SET backfill_cursor = $2, updated_at = now() WHERE id = $1', [
    repositoryId,
    cursor,
  ]);
}

export async function markBackfillComplete(db: Queryable, repositoryId: string): Promise<void> {
  await db.query(
    `UPDATE repositories
        SET backfill_state = 'complete', backfill_completed_at = now(), backfill_cursor = NULL,
            updated_at = now()
      WHERE id = $1`,
    [repositoryId],
  );
}

export async function recordSyncSuccess(
  db: Queryable,
  repositoryId: string,
  syncedThrough: Date,
): Promise<void> {
  await db.query(
    `UPDATE repositories
        SET last_sync_at = now(), last_success_at = now(), last_error = NULL,
            consecutive_failures = 0, synced_through = $2, updated_at = now()
      WHERE id = $1`,
    [repositoryId, syncedThrough],
  );
}

export async function recordSyncFailure(
  db: Queryable,
  repositoryId: string,
  error: string,
): Promise<void> {
  await db.query(
    `UPDATE repositories
        SET last_sync_at = now(), last_failure_at = now(), last_error = $2,
            consecutive_failures = consecutive_failures + 1, updated_at = now()
      WHERE id = $1`,
    [repositoryId, error.slice(0, 2000)],
  );
}

export async function markBackfillFailed(
  db: Queryable,
  repositoryId: string,
  error: string,
): Promise<void> {
  await db.query(
    `UPDATE repositories SET backfill_state = 'failed', last_error = $2, updated_at = now()
      WHERE id = $1`,
    [repositoryId, error.slice(0, 2000)],
  );
}

/** One row per sync attempt, so "when did this last work, and why did it stop" is queryable. */
export async function startSyncRun(
  db: Queryable,
  input: {
    workspaceId: string;
    repositoryId: string;
    kind: 'backfill' | 'incremental' | 'reprocess';
    windowStart?: Date | null;
    windowEnd?: Date | null;
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sync_runs (workspace_id, repository_id, kind, status, window_start, window_end)
     VALUES ($1, $2, $3, 'running', $4, $5) RETURNING id`,
    [
      input.workspaceId,
      input.repositoryId,
      input.kind,
      input.windowStart ?? null,
      input.windowEnd ?? null,
    ],
  );
  return rows[0]!.id;
}

export async function finishSyncRun(
  db: Queryable,
  syncRunId: string,
  outcome: {
    status: 'succeeded' | 'failed' | 'paused';
    pullRequestsSeen?: number;
    error?: string | null;
    cursor?: string | null;
  },
): Promise<void> {
  await db.query(
    `UPDATE sync_runs
        SET status = $2, finished_at = now(), pull_requests_seen = COALESCE($3, pull_requests_seen),
            error = $4, cursor = $5
      WHERE id = $1`,
    [
      syncRunId,
      outcome.status,
      outcome.pullRequestsSeen ?? null,
      outcome.error ?? null,
      outcome.cursor ?? null,
    ],
  );
}

export interface SyncStatusSummary {
  repositoriesInScope: number;
  backfilling: { id: string; fullName: string }[];
  failing: {
    id: string;
    fullName: string;
    lastError: string | null;
    consecutiveFailures: number;
  }[];
  lastSuccessAt: Date | null;
}

/** What the read surfaces need to be honest about completeness (spec: analytics-dashboard). */
export async function syncStatus(db: Queryable, workspaceId: string): Promise<SyncStatusSummary> {
  const repositories = await listRepositories(db, workspaceId, { inScopeOnly: true });
  const lastSuccesses = repositories
    .map((repository) => repository.lastSuccessAt)
    .filter((value): value is Date => value !== null)
    .sort((a, b) => b.getTime() - a.getTime());
  return {
    repositoriesInScope: repositories.length,
    backfilling: repositories
      .filter((repository) => repository.backfillState !== 'complete')
      .map((repository) => ({ id: repository.id, fullName: repository.fullName })),
    failing: repositories
      .filter((repository) => repository.consecutiveFailures > 0)
      .map((repository) => ({
        id: repository.id,
        fullName: repository.fullName,
        lastError: repository.lastError,
        consecutiveFailures: repository.consecutiveFailures,
      })),
    lastSuccessAt: lastSuccesses[0] ?? null,
  };
}
