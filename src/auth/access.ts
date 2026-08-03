/**
 * Authorization (spec: auth-and-access-control, design.md D8).
 *
 * There is no second permission model: a user sees a repository's data here only if GitHub says
 * they can read that repository. Decisions are cached with a short lifetime and dropped whenever
 * an installation changes.
 *
 * Every failure — not a member, no such workspace, repository not visible — surfaces the same
 * `AccessDeniedError`, which callers render as a 404. Distinguishing them would disclose that the
 * resource exists.
 */
import type { Database, Queryable } from '../db/driver';
import { GitHubNotFoundError } from '../github/http';
import { GitHubRestClient } from '../github/rest';
import { listRepositories, type RepositoryRecord } from '../repositories/store';
import { getMembership } from '../workspaces/store';
import type { UserRecord } from './users';

export class AccessDeniedError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

export type Role = 'owner' | 'member';

export interface WorkspaceAccess {
  workspaceId: string;
  user: UserRecord;
  role: Role;
  /** Repositories in scope that this user may see on GitHub. */
  visibleRepositories: RepositoryRecord[];
  visibleRepositoryIds: string[];
}

export interface PermissionChecker {
  /** True when the user can read the repository on GitHub. */
  canRead(repository: RepositoryRecord): Promise<boolean>;
}

/** The real check: ask GitHub with the user's own token. 404 means "not visible to you". */
export class GitHubPermissionChecker implements PermissionChecker {
  private readonly client: GitHubRestClient;

  constructor(userToken: string, apiBaseUrl: string, fetchImpl?: typeof fetch) {
    this.client = new GitHubRestClient({ apiBaseUrl, token: () => userToken, fetchImpl });
  }

  async canRead(repository: RepositoryRecord): Promise<boolean> {
    try {
      await this.client.getRepository(repository.ownerLogin, repository.name);
      return true;
    } catch (error) {
      if (error instanceof GitHubNotFoundError) return false;
      throw error;
    }
  }
}

/** Everything visible — for tests and for background jobs that are not acting for a user. */
export const allowAll: PermissionChecker = { canRead: async () => true };

/**
 * How many permission checks may be in flight against GitHub at once on a cache miss.
 *
 * Deliberately low (design.md D1): a workspace with fifty repositories must not open fifty
 * simultaneous requests, both for GitHub's secondary rate limits and for the connection budget of
 * a serverless function. Raise it from observed limits, not from impatience.
 */
const PERMISSION_CHECK_CONCURRENCY = 5;

/**
 * One read for the whole repository set. Same triple as the per-repository read it replaces —
 * workspace, user, repository — and the same expiry rule, so "absent" and "expired" are both
 * simply missing from the returned map. Dropping a predicate here would widen visibility silently,
 * which is the failure this codebase most wants to avoid (design.md D1).
 */
async function cachedDecisions(
  db: Queryable,
  workspaceId: string,
  userId: string,
  repositoryIds: readonly string[],
): Promise<Map<string, boolean>> {
  if (repositoryIds.length === 0) return new Map();
  const { rows } = await db.query<{ repository_id: string; can_read: boolean }>(
    `SELECT repository_id, can_read FROM repository_permissions
      WHERE workspace_id = $1 AND user_id = $2 AND repository_id = ANY($3::uuid[])
        AND expires_at > now()`,
    [workspaceId, userId, [...repositoryIds]],
  );
  return new Map(rows.map((row) => [row.repository_id, row.can_read]));
}

/** One write for every newly-decided row. */
async function cacheDecisions(
  db: Queryable,
  input: {
    workspaceId: string;
    userId: string;
    decisions: ReadonlyArray<{ repositoryId: string; canRead: boolean }>;
    ttlSeconds: number;
  },
): Promise<void> {
  if (input.decisions.length === 0) return;
  await db.query(
    `INSERT INTO repository_permissions
       (workspace_id, user_id, repository_id, can_read, checked_at, expires_at)
     SELECT $1, $2, decision.repository_id, decision.can_read, now(),
            now() + make_interval(secs => $5::double precision)
       FROM unnest($3::uuid[], $4::boolean[]) AS decision (repository_id, can_read)
     ON CONFLICT (workspace_id, user_id, repository_id) DO UPDATE
       SET can_read = EXCLUDED.can_read,
           checked_at = EXCLUDED.checked_at,
           expires_at = EXCLUDED.expires_at`,
    [
      input.workspaceId,
      input.userId,
      input.decisions.map((decision) => decision.repositoryId),
      input.decisions.map((decision) => decision.canRead),
      input.ttlSeconds,
    ],
  );
}

/** Map with at most `limit` calls in flight. Results keep the input's order; the first rejection
 * propagates, as the serial loop's would have. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface ResolveAccessOptions {
  workspaceId: string;
  user: UserRecord;
  checker: PermissionChecker;
  permissionCacheSeconds: number;
  /** Ownership is required for configuration actions (repository selection, teams, …). */
  requireOwner?: boolean;
}

/**
 * Resolve what this user may do and see in this workspace. Call it on every read path; the
 * returned repository ids are the only ones any query should be given.
 */
export async function resolveWorkspaceAccess(
  database: Database,
  options: ResolveAccessOptions,
): Promise<WorkspaceAccess> {
  const membership = await getMembership(database, options.workspaceId, options.user.id);
  if (!membership) throw new AccessDeniedError();
  if (options.requireOwner && membership.role !== 'owner') throw new AccessDeniedError();

  const repositories = await listRepositories(database, options.workspaceId, {
    inScopeOnly: true,
  });

  /**
   * Two round trips, not one per repository (spec: auth-and-access-control, design.md D1): read
   * every cached decision at once, resolve only the misses against GitHub — concurrently, under a
   * bound — and write those back at once.
   */
  const cached = await cachedDecisions(
    database,
    options.workspaceId,
    options.user.id,
    repositories.map((repository) => repository.id),
  );
  const misses = repositories.filter((repository) => !cached.has(repository.id));
  const resolved = await mapBounded(misses, PERMISSION_CHECK_CONCURRENCY, async (repository) => ({
    repositoryId: repository.id,
    canRead: await options.checker.canRead(repository),
  }));
  await cacheDecisions(database, {
    workspaceId: options.workspaceId,
    userId: options.user.id,
    decisions: resolved,
    ttlSeconds: options.permissionCacheSeconds,
  });

  const decisions = new Map(cached);
  for (const decision of resolved) decisions.set(decision.repositoryId, decision.canRead);
  const visible = repositories.filter((repository) => decisions.get(repository.id) === true);

  return {
    workspaceId: options.workspaceId,
    user: options.user,
    role: membership.role,
    visibleRepositories: visible,
    visibleRepositoryIds: visible.map((repository) => repository.id),
  };
}

export function assertOwner(access: WorkspaceAccess): void {
  if (access.role !== 'owner') throw new AccessDeniedError();
}

export function assertRepositoryVisible(access: WorkspaceAccess, repositoryId: string): void {
  if (!access.visibleRepositoryIds.includes(repositoryId)) throw new AccessDeniedError();
}

/**
 * Per-contributor detail is limited to workspace owners and the contributor themselves
 * (spec: analytics-dashboard).
 */
export async function assertMayViewContributor(
  db: Queryable,
  access: WorkspaceAccess,
  contributorId: string,
): Promise<void> {
  if (access.role === 'owner') return;
  const { rows } = await db.query<{ node_id: string; github_user_id: number | null }>(
    'SELECT node_id, github_user_id FROM contributors WHERE workspace_id = $1 AND id = $2',
    [access.workspaceId, contributorId],
  );
  const contributor = rows[0];
  if (!contributor) throw new AccessDeniedError();
  const isSelf =
    contributor.node_id === access.user.githubNodeId ||
    (contributor.github_user_id !== null &&
      Number(contributor.github_user_id) === access.user.githubUserId);
  if (!isSelf) throw new AccessDeniedError();
}
