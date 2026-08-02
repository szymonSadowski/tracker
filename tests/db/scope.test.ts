import { describe, expect, it } from 'vitest';
import { databaseFixture } from '../helpers/db';
import { seedPullRequest, seedRepository, seedWorkspace } from '../helpers/factories';
import {
  MissingWorkspaceScopeError,
  WORKSPACE_SCOPED_TABLES,
  workspaceScope,
} from '../../src/db/scope';

const db = databaseFixture();

describe('workspace-scoped data access', () => {
  it('rejects a read of a scoped table that carries no workspace scope', async () => {
    const scope = workspaceScope(db(), '00000000-0000-0000-0000-000000000001');
    await expect(scope.query('SELECT * FROM pull_requests')).rejects.toBeInstanceOf(
      MissingWorkspaceScopeError,
    );
  });

  it('binds the workspace marker and returns only that workspace’s rows', async () => {
    const one = await seedWorkspace(db());
    const two = await seedWorkspace(db());
    const repoOne = await seedRepository(db(), one.id);
    const repoTwo = await seedRepository(db(), two.id);
    await seedPullRequest(db(), { workspaceId: one.id, repositoryId: repoOne.id, title: 'one' });
    await seedPullRequest(db(), { workspaceId: two.id, repositoryId: repoTwo.id, title: 'two' });

    const scope = workspaceScope(db(), one.id);
    const result = await scope.query<{ title: string }>(
      'SELECT title FROM pull_requests WHERE workspace_id = :workspace',
    );

    expect(result.rows.map((row) => row.title)).toEqual(['one']);
  });

  it('keeps the caller’s parameter numbering intact', async () => {
    const workspace = await seedWorkspace(db());
    const repo = await seedRepository(db(), workspace.id);
    await seedPullRequest(db(), {
      workspaceId: workspace.id,
      repositoryId: repo.id,
      state: 'open',
      mergedAt: null,
    });

    const scope = workspaceScope(db(), workspace.id);
    const result = await scope.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM pull_requests WHERE state = $1 AND workspace_id = :workspace',
      ['open'],
    );

    expect(result.rows[0]!.count).toBe(1);
  });

  it('lists every table that actually carries workspace_id', async () => {
    const { rows } = await db().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE column_name = 'workspace_id' AND table_schema = 'public'
       GROUP BY table_name ORDER BY table_name`,
    );
    expect(rows.map((row) => row.table_name).sort()).toEqual([...WORKSPACE_SCOPED_TABLES].sort());
  });
});
