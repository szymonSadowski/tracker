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

async function cachedDecision(
  db: Queryable,
  workspaceId: string,
  userId: string,
  repositoryId: string,
): Promise<boolean | undefined> {
  const { rows } = await db.query<{ can_read: boolean }>(
    `SELECT can_read FROM repository_permissions
      WHERE workspace_id = $1 AND user_id = $2 AND repository_id = $3 AND expires_at > now()`,
    [workspaceId, userId, repositoryId],
  );
  return rows[0]?.can_read;
}

async function cacheDecision(
  db: Queryable,
  input: {
    workspaceId: string;
    userId: string;
    repositoryId: string;
    canRead: boolean;
    ttlSeconds: number;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO repository_permissions
       (workspace_id, user_id, repository_id, can_read, checked_at, expires_at)
     VALUES ($1, $2, $3, $4, now(), now() + make_interval(secs => $5::double precision))
     ON CONFLICT (workspace_id, user_id, repository_id) DO UPDATE
       SET can_read = EXCLUDED.can_read,
           checked_at = EXCLUDED.checked_at,
           expires_at = EXCLUDED.expires_at`,
    [input.workspaceId, input.userId, input.repositoryId, input.canRead, input.ttlSeconds],
  );
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

  const visible: RepositoryRecord[] = [];
  for (const repository of repositories) {
    const cached = await cachedDecision(
      database,
      options.workspaceId,
      options.user.id,
      repository.id,
    );
    const canRead = cached ?? (await options.checker.canRead(repository));
    if (cached === undefined) {
      await cacheDecision(database, {
        workspaceId: options.workspaceId,
        userId: options.user.id,
        repositoryId: repository.id,
        canRead,
        ttlSeconds: options.permissionCacheSeconds,
      });
    }
    if (canRead) visible.push(repository);
  }

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
