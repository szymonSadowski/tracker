import { describe, expect, it } from 'vitest';
import { databaseFixture } from '../helpers/db';
import {
  at,
  seedContributor,
  seedMembership,
  seedPullRequest,
  seedRepository,
  seedUser,
  seedWorkspace,
} from '../helpers/factories';
import {
  AccessDeniedError,
  allowAll,
  assertMayViewContributor,
  resolveWorkspaceAccess,
  type PermissionChecker,
} from '../../src/auth/access';
import { createSession, resolveSession, revokeSession } from '../../src/auth/session';
import { contributorForUser, upsertUser } from '../../src/auth/users';
import { teamMetrics } from '../../src/analysis/aggregate';
import { analyzePullRequest } from '../../src/analysis/service';
import { workspaceScope } from '../../src/db/scope';
import { invalidatePermissionCache } from '../../src/installations/service';
import { GitHubAuthError } from '../../src/github/http';
import { listRepositories, type RepositoryRecord } from '../../src/repositories/store';
import type { Database, QueryResult, Transaction } from '../../src/db/driver';

const db = databaseFixture();

const period = {
  start: new Date('2026-01-01T00:00:00Z'),
  end: new Date('2027-01-01T00:00:00Z'),
  label: '',
};

class ScriptedChecker implements PermissionChecker {
  calls = 0;

  constructor(private readonly readable: Set<string>) {}

  async canRead(repository: RepositoryRecord): Promise<boolean> {
    this.calls++;
    return this.readable.has(repository.name);
  }
}

async function fixture() {
  const workspace = await seedWorkspace(db());
  const open = await seedRepository(db(), workspace.id, { name: 'open-repo' });
  const secret = await seedRepository(db(), workspace.id, { name: 'secret-repo' });
  const owner = await seedUser(db(), { login: 'owner' });
  const member = await seedUser(db(), { login: 'member' });
  const outsider = await seedUser(db(), { login: 'outsider' });
  await seedMembership(db(), workspace.id, owner.id, 'owner');
  await seedMembership(db(), workspace.id, member.id, 'member');
  return { workspace, open, secret, owner, member, outsider };
}

describe('workspace access', () => {
  it('refuses a user who is not a member without saying whether the workspace exists', async () => {
    const { workspace, outsider } = await fixture();
    const user = (
      await db().query<{ id: string }>('SELECT id FROM users WHERE id = $1', [outsider.id])
    ).rows[0]!;

    await expect(
      resolveWorkspaceAccess(db(), {
        workspaceId: workspace.id,
        user: {
          id: user.id,
          githubUserId: 1,
          githubNodeId: 'U_x',
          login: 'outsider',
          name: null,
          avatarUrl: null,
        },
        checker: allowAll,
        permissionCacheSeconds: 300,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    // The same error, and the same message, as for a workspace that does not exist.
    await expect(
      resolveWorkspaceAccess(db(), {
        workspaceId: '00000000-0000-0000-0000-000000000000',
        user: {
          id: user.id,
          githubUserId: 1,
          githubNodeId: 'U_x',
          login: 'outsider',
          name: null,
          avatarUrl: null,
        },
        checker: allowAll,
        permissionCacheSeconds: 300,
      }),
    ).rejects.toThrow('Not found');
  });

  it('filters a member’s view to the repositories GitHub lets them read', async () => {
    const { workspace, open, secret, member } = await fixture();
    const author = await seedContributor(db(), workspace.id);
    for (const repository of [open, secret]) {
      await seedPullRequest(db(), {
        workspaceId: workspace.id,
        repositoryId: repository.id,
        authorContributorId: author.id,
        mergedAt: at(4),
      });
    }
    const prs = await db().query<{ id: string }>('SELECT id FROM pull_requests');
    for (const row of prs.rows) await db().transaction((tx) => analyzePullRequest(tx, row.id));

    const checker = new ScriptedChecker(new Set(['open-repo']));
    const access = await resolveWorkspaceAccess(db(), {
      workspaceId: workspace.id,
      user: {
        id: member.id,
        githubUserId: member.githubUserId,
        githubNodeId: member.githubNodeId,
        login: member.login,
        name: null,
        avatarUrl: null,
      },
      checker,
      permissionCacheSeconds: 300,
    });

    expect(access.visibleRepositories.map((r) => r.name)).toEqual(['open-repo']);

    const metrics = await teamMetrics(workspaceScope(db(), workspace.id), {
      period,
      repositoryIds: access.visibleRepositoryIds,
    });
    // The aggregate is over the visible repository only.
    expect(metrics.mergedCount).toBe(1);
  });

  it('answers repeated checks from cache, and re-asks after an installation change', async () => {
    const { workspace, member } = await fixture();
    const checker = new ScriptedChecker(new Set(['open-repo', 'secret-repo']));
    const user = {
      id: member.id,
      githubUserId: member.githubUserId,
      githubNodeId: member.githubNodeId,
      login: member.login,
      name: null,
      avatarUrl: null,
    };
    const resolve = () =>
      resolveWorkspaceAccess(db(), {
        workspaceId: workspace.id,
        user,
        checker,
        permissionCacheSeconds: 300,
      });

    await resolve();
    expect(checker.calls).toBe(2);
    await resolve();
    await resolve();
    expect(checker.calls).toBe(2);

    // A changed repository selection invalidates the cache immediately.
    await invalidatePermissionCache(db(), workspace.id);
    await resolve();
    expect(checker.calls).toBe(4);
  });

  it('stops showing a repository once GitHub revokes access and the cache expires', async () => {
    const { workspace, member } = await fixture();
    const readable = new Set(['open-repo', 'secret-repo']);
    const checker = new ScriptedChecker(readable);
    const user = {
      id: member.id,
      githubUserId: member.githubUserId,
      githubNodeId: member.githubNodeId,
      login: member.login,
      name: null,
      avatarUrl: null,
    };

    const first = await resolveWorkspaceAccess(db(), {
      workspaceId: workspace.id,
      user,
      checker,
      permissionCacheSeconds: 300,
    });
    expect(first.visibleRepositories).toHaveLength(2);

    readable.delete('secret-repo');
    await db().query("UPDATE repository_permissions SET expires_at = now() - interval '1 minute'");

    const second = await resolveWorkspaceAccess(db(), {
      workspaceId: workspace.id,
      user,
      checker,
      permissionCacheSeconds: 300,
    });
    expect(second.visibleRepositories.map((r) => r.name)).toEqual(['open-repo']);
  });

  it('requires ownership for configuration actions', async () => {
    const { workspace, member, owner } = await fixture();
    const asUser = (u: {
      id: string;
      githubUserId: number;
      githubNodeId: string;
      login: string;
    }) => ({
      id: u.id,
      githubUserId: u.githubUserId,
      githubNodeId: u.githubNodeId,
      login: u.login,
      name: null,
      avatarUrl: null,
    });

    await expect(
      resolveWorkspaceAccess(db(), {
        workspaceId: workspace.id,
        user: asUser(member),
        checker: allowAll,
        permissionCacheSeconds: 300,
        requireOwner: true,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);

    const asOwner = await resolveWorkspaceAccess(db(), {
      workspaceId: workspace.id,
      user: asUser(owner),
      checker: allowAll,
      permissionCacheSeconds: 300,
      requireOwner: true,
    });
    expect(asOwner.role).toBe('owner');
  });

  it('restricts a colleague’s detail to owners and the contributor themselves', async () => {
    const { workspace, member, owner } = await fixture();
    const colleague = await seedContributor(db(), workspace.id, { login: 'someone-else' });
    const self = await seedContributor(db(), workspace.id, {
      login: member.login,
      nodeId: member.githubNodeId,
    });

    const access = await resolveWorkspaceAccess(db(), {
      workspaceId: workspace.id,
      user: {
        id: member.id,
        githubUserId: member.githubUserId,
        githubNodeId: member.githubNodeId,
        login: member.login,
        name: null,
        avatarUrl: null,
      },
      checker: allowAll,
      permissionCacheSeconds: 300,
    });

    await expect(assertMayViewContributor(db(), access, colleague.id)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await expect(assertMayViewContributor(db(), access, self.id)).resolves.toBeUndefined();

    const ownerAccess = await resolveWorkspaceAccess(db(), {
      workspaceId: workspace.id,
      user: {
        id: owner.id,
        githubUserId: owner.githubUserId,
        githubNodeId: owner.githubNodeId,
        login: owner.login,
        name: null,
        avatarUrl: null,
      },
      checker: allowAll,
      permissionCacheSeconds: 300,
    });
    await expect(
      assertMayViewContributor(db(), ownerAccess, colleague.id),
    ).resolves.toBeUndefined();
  });
});

/**
 * The access check reads cached decisions for the whole repository set at once rather than one at
 * a time (spec: auth-and-access-control). Batching is where a dropped `workspace_id` or `user_id`
 * predicate would widen visibility silently, so these compare the batched result against a check
 * made one repository at a time, and count the round trips it costs.
 */
describe('resolving access in batch', () => {
  /** Counts every statement so a test can assert the count does not follow workspace size. */
  class CountingDatabase implements Database {
    queries = 0;

    constructor(private readonly base: Database) {}

    query<R = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ): Promise<QueryResult<R>> {
      this.queries++;
      return this.base.query<R>(sql, params);
    }

    exec(sql: string): Promise<void> {
      return this.base.exec(sql);
    }

    transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
      return this.base.transaction(fn);
    }

    async close(): Promise<void> {
      // The fixture owns the connection.
    }
  }

  async function workspaceOf(repositoryNames: string[]) {
    const workspace = await seedWorkspace(db());
    for (const name of repositoryNames) await seedRepository(db(), workspace.id, { name });
    const member = await seedUser(db());
    await seedMembership(db(), workspace.id, member.id, 'member');
    return {
      workspaceId: workspace.id,
      user: {
        id: member.id,
        githubUserId: member.githubUserId,
        githubNodeId: member.githubNodeId,
        login: member.login,
        name: null,
        avatarUrl: null,
      },
    };
  }

  /** What the previous implementation would have returned: one check per repository, in order. */
  async function oneAtATime(workspaceId: string, checker: PermissionChecker): Promise<string[]> {
    const repositories = await listRepositories(db(), workspaceId, { inScopeOnly: true });
    const visible: string[] = [];
    for (const repository of repositories) {
      if (await checker.canRead(repository)) visible.push(repository.name);
    }
    return visible;
  }

  it('returns exactly what a one-at-a-time check returns, for a mixed permission set', async () => {
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'];
    const { workspaceId, user } = await workspaceOf(names);
    const readable = new Set(['alpha', 'gamma', 'zeta']);

    const access = await resolveWorkspaceAccess(db(), {
      workspaceId,
      user,
      checker: new ScriptedChecker(readable),
      permissionCacheSeconds: 300,
    });

    expect(access.visibleRepositories.map((r) => r.name)).toEqual(
      await oneAtATime(workspaceId, new ScriptedChecker(readable)),
    );
    expect(access.visibleRepositories.map((r) => r.name).sort()).toEqual([...readable].sort());
  });

  it('gives a user permitted none of the repositories an empty set, not everything', async () => {
    const { workspaceId, user } = await workspaceOf(['one', 'two', 'three']);

    const access = await resolveWorkspaceAccess(db(), {
      workspaceId,
      user,
      checker: new ScriptedChecker(new Set()),
      permissionCacheSeconds: 300,
    });

    expect(access.visibleRepositories).toEqual([]);
    expect(access.visibleRepositoryIds).toEqual([]);
  });

  it('never lets one workspace’s cached decision answer for another', async () => {
    const first = await workspaceOf(['shared-name']);
    const second = await workspaceOf(['shared-name']);
    await resolveWorkspaceAccess(db(), {
      workspaceId: first.workspaceId,
      user: first.user,
      checker: allowAll,
      permissionCacheSeconds: 300,
    });

    // A cached "yes" in the first workspace must not decide the second, for either its own member
    // or the first workspace's.
    const refusing = new ScriptedChecker(new Set());
    const access = await resolveWorkspaceAccess(db(), {
      workspaceId: second.workspaceId,
      user: second.user,
      checker: refusing,
      permissionCacheSeconds: 300,
    });

    expect(access.visibleRepositories).toEqual([]);
    expect(refusing.calls).toBe(1);
  });

  it('re-resolves an entirely expired cache and returns the same set', async () => {
    const names = ['alpha', 'beta', 'gamma', 'delta'];
    const { workspaceId, user } = await workspaceOf(names);
    const readable = new Set(['beta', 'delta']);
    const checker = new ScriptedChecker(readable);
    const resolve = () =>
      resolveWorkspaceAccess(db(), { workspaceId, user, checker, permissionCacheSeconds: 300 });

    const first = await resolve();
    expect(checker.calls).toBe(names.length);

    await db().query(
      "UPDATE repository_permissions SET expires_at = now() - interval '1 minute' WHERE workspace_id = $1",
      [workspaceId],
    );

    const second = await resolve();
    expect(checker.calls).toBe(names.length * 2);
    expect(second.visibleRepositories.map((r) => r.name)).toEqual(
      first.visibleRepositories.map((r) => r.name),
    );
  });

  it('costs the same number of round trips for one repository as for many', async () => {
    const small = await workspaceOf(['only']);
    const large = await workspaceOf(Array.from({ length: 12 }, (_, i) => `repo-${i}`));

    const count = async (workspace: Awaited<ReturnType<typeof workspaceOf>>) => {
      // Warm the cache first: this measures the cached path, which is every page load but one.
      await resolveWorkspaceAccess(db(), {
        workspaceId: workspace.workspaceId,
        user: workspace.user,
        checker: allowAll,
        permissionCacheSeconds: 300,
      });
      const counting = new CountingDatabase(db());
      await resolveWorkspaceAccess(counting, {
        workspaceId: workspace.workspaceId,
        user: workspace.user,
        checker: allowAll,
        permissionCacheSeconds: 300,
      });
      return counting.queries;
    };

    expect(await count(large)).toBe(await count(small));
  });
});

describe('a rejected user token', () => {
  /**
   * GitHub rejecting the user's own credentials is not the same as the user lacking access, and
   * must not be flattened into "cannot read" — that would silently render an empty workspace as
   * though the repositories were private. It propagates so the caller can revoke the session and
   * send the viewer back through sign-in.
   */
  it('propagates rather than reading as "not visible"', async () => {
    const { workspace, owner } = await fixture();
    const failing: PermissionChecker = {
      canRead: async () => {
        throw new GitHubAuthError('GitHub rejected credentials (401)', 401, 'Bad credentials');
      },
    };

    await expect(
      resolveWorkspaceAccess(db(), {
        workspaceId: workspace.id,
        user: {
          id: owner.id,
          githubUserId: owner.githubUserId,
          githubNodeId: owner.githubNodeId,
          login: owner.login,
          name: null,
          avatarUrl: null,
        },
        checker: failing,
        permissionCacheSeconds: 300,
      }),
    ).rejects.toBeInstanceOf(GitHubAuthError);
  });

  it('leaves no usable session once revoked', async () => {
    const { owner } = await fixture();
    const session = await createSession(db(), {
      userId: owner.id,
      githubToken: 'stale-token',
      inactivityMinutes: 60,
    });

    await revokeSession(db(), session.token);

    expect(await resolveSession(db(), session.token, { inactivityMinutes: 60 })).toBeUndefined();
  });
});

describe('identity and sessions', () => {
  it('recognizes a renamed GitHub account as the same user', async () => {
    const first = await upsertUser(db(), {
      githubUserId: 4242,
      githubNodeId: 'U_stable',
      login: 'ada',
    });
    const renamed = await upsertUser(db(), {
      githubUserId: 4242,
      githubNodeId: 'U_stable',
      login: 'ada-lovelace',
    });

    expect(renamed.id).toBe(first.id);
    expect((await db().query('SELECT id FROM users')).rows).toHaveLength(1);
  });

  it('links a signed-in user to their contributor record with no mapping step', async () => {
    const workspace = await seedWorkspace(db());
    const contributor = await seedContributor(db(), workspace.id, {
      login: 'ada',
      nodeId: 'U_ada',
    });
    const user = await upsertUser(db(), {
      githubUserId: 11,
      githubNodeId: 'U_ada',
      login: 'ada',
    });

    const linked = await contributorForUser(db(), workspace.id, user);
    expect(linked?.id).toBe(contributor.id);
  });

  it('expires an idle session and revokes one on sign-out', async () => {
    const user = await seedUser(db());
    const { token } = await createSession(db(), { userId: user.id, inactivityMinutes: 60 });

    expect(await resolveSession(db(), token, { inactivityMinutes: 60 })).toBeDefined();

    await revokeSession(db(), token);
    expect(await resolveSession(db(), token, { inactivityMinutes: 60 })).toBeUndefined();

    const second = await createSession(db(), { userId: user.id, inactivityMinutes: 60 });
    await db().query(
      "UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE revoked_at IS NULL",
    );
    expect(await resolveSession(db(), second.token, { inactivityMinutes: 60 })).toBeUndefined();
  });

  it('stores only a hash of the session token', async () => {
    const user = await seedUser(db());
    const { token } = await createSession(db(), { userId: user.id, inactivityMinutes: 60 });
    const { rows } = await db().query<{ id: string }>('SELECT id FROM sessions');
    expect(rows[0]!.id).not.toBe(token);
    expect(rows[0]!.id).toHaveLength(64);
  });
});
