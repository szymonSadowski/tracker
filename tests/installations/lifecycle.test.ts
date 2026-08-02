import { describe, expect, it } from 'vitest';
import { databaseFixture } from '../helpers/db';
import { seedUser } from '../helpers/factories';
import {
  ingestInstallation,
  refreshRepositorySelection,
  type GitHubInstallationDetails,
  type InstallationGateway,
} from '../../src/installations/github-sync';
import {
  markInstallationNeedsAttention,
  markInstallationUninstalled,
} from '../../src/installations/service';
import {
  findInstallationByGitHubId,
  findInstallationByWorkspace,
} from '../../src/installations/store';
import { listRepositories } from '../../src/repositories/store';
import { countJobs } from '../../src/jobs/queue';
import type { RestRepository } from '../../src/github/rest';

const db = databaseFixture();

function repository(name: string, nodeId = `R_${name}`): RestRepository {
  return {
    id: name.length * 1000,
    node_id: nodeId,
    name,
    full_name: `acme/${name}`,
    private: true,
    default_branch: 'main',
    owner: { login: 'acme', id: 1, node_id: 'O_acme', type: 'Organization' },
  };
}

class FakeGateway implements InstallationGateway {
  constructor(
    public installation: GitHubInstallationDetails,
    public repositories: RestRepository[],
  ) {}

  async getInstallation(): Promise<GitHubInstallationDetails> {
    return this.installation;
  }

  async listRepositories(): Promise<RestRepository[]> {
    return this.repositories;
  }
}

const installationDetails = (id = 555): GitHubInstallationDetails => ({
  id,
  account: { node_id: 'O_acme', login: 'acme', type: 'Organization' },
  repository_selection: 'selected',
});

describe('installation lifecycle', () => {
  it('records only the selected repositories and makes the installer an owner', async () => {
    const user = await seedUser(db(), { login: 'installer' });
    const gateway = new FakeGateway(installationDetails(), [
      repository('api'),
      repository('web'),
      repository('infra'),
    ]);

    const result = await ingestInstallation(db(), gateway, 555, user.id);

    expect(result.workspaceCreated).toBe(true);
    const repositories = await listRepositories(db(), result.workspaceId);
    expect(repositories.map((r) => r.fullName).sort()).toEqual([
      'acme/api',
      'acme/infra',
      'acme/web',
    ]);
    const { rows } = await db().query<{ role: string }>(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [result.workspaceId, user.id],
    );
    expect(rows[0]?.role).toBe('owner');
    // One backfill per repository entering scope.
    expect(
      await countJobs(db(), { workspaceId: result.workspaceId, type: 'repository.backfill' }),
    ).toBe(3);
  });

  it('updates the existing installation instead of duplicating the workspace', async () => {
    const gateway = new FakeGateway(installationDetails(), [repository('api')]);
    const first = await ingestInstallation(db(), gateway, 555);

    // Re-installing an account yields a new GitHub installation id for the same account.
    gateway.installation = { ...installationDetails(777), repository_selection: 'selected' };
    const second = await ingestInstallation(db(), gateway, 777);

    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.workspaceCreated).toBe(false);
    const workspaces = await db().query('SELECT id FROM workspaces');
    expect(workspaces.rows).toHaveLength(1);
    const installations = await db().query('SELECT id FROM installations');
    expect(installations.rows).toHaveLength(1);
    expect((await findInstallationByWorkspace(db(), first.workspaceId))?.githubInstallationId).toBe(
      777,
    );
  });

  it('follows a repository rename without orphaning its pull requests', async () => {
    const gateway = new FakeGateway(installationDetails(), [repository('api', 'R_stable')]);
    const { workspaceId } = await ingestInstallation(db(), gateway, 555);
    const before = (await listRepositories(db(), workspaceId))[0]!;

    await db().query(
      `INSERT INTO pull_requests
         (workspace_id, repository_id, node_id, number, state, opened_at, github_updated_at)
       VALUES ($1, $2, 'PR_1', 1, 'merged', now(), now())`,
      [workspaceId, before.id],
    );

    gateway.repositories = [
      { ...repository('platform-api', 'R_stable'), full_name: 'acme/platform-api' },
    ];
    const result = await refreshRepositorySelection(db(), gateway, workspaceId, 555);

    expect(result.renamed).toEqual([{ from: 'acme/api', to: 'acme/platform-api' }]);
    const after = await listRepositories(db(), workspaceId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before.id);
    const prs = await db().query('SELECT repository_id FROM pull_requests');
    expect(prs.rows[0]).toMatchObject({ repository_id: before.id });
  });

  it('deselecting a repository stops its sync but keeps its data', async () => {
    const gateway = new FakeGateway(installationDetails(), [repository('api'), repository('web')]);
    const { workspaceId } = await ingestInstallation(db(), gateway, 555);
    const web = (await listRepositories(db(), workspaceId)).find((r) => r.name === 'web')!;
    await db().query(
      `INSERT INTO pull_requests
         (workspace_id, repository_id, node_id, number, state, opened_at, github_updated_at)
       VALUES ($1, $2, 'PR_web', 1, 'merged', now(), now())`,
      [workspaceId, web.id],
    );

    gateway.repositories = [repository('api')];
    const result = await refreshRepositorySelection(db(), gateway, workspaceId, 555);

    expect(result.removed).toEqual(['acme/web']);
    const all = await listRepositories(db(), workspaceId);
    expect(all.find((r) => r.name === 'web')!.inScope).toBe(false);
    expect(await listRepositories(db(), workspaceId, { inScopeOnly: true })).toHaveLength(1);
    // Data is retained…
    const prs = await db().query('SELECT id FROM pull_requests');
    expect(prs.rows).toHaveLength(1);
    // …and its queued sync work is cancelled.
    const pending = await db().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM jobs
        WHERE state = 'pending' AND payload->>'repositoryId' = $1`,
      [web.id],
    );
    expect(pending.rows[0]!.count).toBe(0);
  });

  it('adding a repository later enqueues just that backfill', async () => {
    const gateway = new FakeGateway(installationDetails(), [repository('api')]);
    const { workspaceId } = await ingestInstallation(db(), gateway, 555);
    // The first repository has finished its backfill; only the new one needs work.
    await db().query("UPDATE jobs SET state = 'succeeded'");
    await db().query("UPDATE repositories SET backfill_state = 'complete'");

    gateway.repositories = [repository('api'), repository('web')];
    const result = await refreshRepositorySelection(db(), gateway, workspaceId, 555);

    expect(result.added).toEqual(['acme/web']);
    expect(await countJobs(db(), { workspaceId, state: 'pending' })).toBe(1);
  });

  it('uninstalling stops work and discards credentials while data stays readable', async () => {
    const gateway = new FakeGateway(installationDetails(), [repository('api')]);
    const { workspaceId } = await ingestInstallation(db(), gateway, 555);
    const repo = (await listRepositories(db(), workspaceId))[0]!;
    await db().query(
      `INSERT INTO pull_requests
         (workspace_id, repository_id, node_id, number, state, opened_at, github_updated_at)
       VALUES ($1, $2, 'PR_1', 1, 'merged', now(), now())`,
      [workspaceId, repo.id],
    );

    const discarded: number[] = [];
    const outcome = await markInstallationUninstalled(db(), 555, {
      onCredentialsDiscarded: (id) => discarded.push(id),
    });

    expect(outcome).toMatchObject({ workspaceId, cancelledJobs: 1 });
    expect(discarded).toEqual([555]);
    expect((await findInstallationByGitHubId(db(), 555))?.status).toBe('uninstalled');
    expect(await countJobs(db(), { workspaceId, state: 'pending' })).toBe(0);
    const prs = await db().query('SELECT id FROM pull_requests');
    expect(prs.rows).toHaveLength(1);
  });

  it('parks an installation whose credentials GitHub rejects', async () => {
    const gateway = new FakeGateway(installationDetails(), [repository('api')]);
    const { workspaceId } = await ingestInstallation(db(), gateway, 555);

    await markInstallationNeedsAttention(db(), workspaceId, 'GitHub rejected credentials (401)');

    const installation = (await findInstallationByWorkspace(db(), workspaceId))!;
    expect(installation.status).toBe('needs_attention');
    expect(installation.statusReason).toContain('401');
    expect(await countJobs(db(), { workspaceId, state: 'pending' })).toBe(0);
  });
});
