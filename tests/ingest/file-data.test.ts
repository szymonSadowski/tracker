/**
 * Per-file diffs, review comments, and default-branch commits (spec: github-data-sync).
 *
 * The property under test throughout is that what gets stored does not depend on which path
 * stored it, and that ingesting the same thing twice is a no-op.
 */
import { describe, expect, it } from 'vitest';
import { databaseFixture } from '../helpers/db';
import { seedContributor, seedRepository, seedWorkspace } from '../helpers/factories';
import { graphqlPullRequest, restPullRequest } from '../helpers/github-fixtures';
import { runBackfill } from '../../src/ingest/backfill';
import { mapGraphQLPullRequest } from '../../src/ingest/graphql-map';
import { mapRestPullRequest } from '../../src/ingest/rest-map';
import { persistPullRequest } from '../../src/ingest/normalize';
import { persistRepositoryCommits } from '../../src/ingest/commits';
import { runFileFillIn } from '../../src/ingest/file-fill-in';
import { listCoverage } from '../../src/repositories/coverage';
import { RateLimitTracker } from '../../src/github/rate-limit';
import type { GitHubGraphQLClient, PullRequestPage } from '../../src/github/graphql';
import type { GitHubRestClient } from '../../src/github/rest';

const db = databaseFixture();

const NOW = new Date('2026-04-10T09:00:00.000Z');
const now = () => NOW;

async function workspaceWithRepo() {
  const workspace = await seedWorkspace(db());
  const repository = await seedRepository(db(), workspace.id, {
    name: 'api',
    backfillState: 'pending',
  });
  return { workspaceId: workspace.id, repositoryId: repository.id };
}

interface FileRow {
  path: string;
  additions: number;
  deletions: number;
  change_kind: string;
}

const files = async (): Promise<FileRow[]> =>
  (
    await db().query<FileRow>(
      'SELECT path, additions, deletions, change_kind FROM pr_files ORDER BY path',
    )
  ).rows;

describe('per-file diff ingestion', () => {
  it('produces identical file and comment records from either path', async () => {
    const graphql = await workspaceWithRepo();
    await db().transaction((tx) =>
      persistPullRequest(tx, {
        ...graphql,
        pullRequest: mapGraphQLPullRequest(graphqlPullRequest()),
        source: 'graphql_backfill',
      }),
    );
    const fromGraphQL = await files();
    const graphQLComments = await db().query<{ node_id: string }>(
      'SELECT node_id FROM pr_review_comments ORDER BY node_id',
    );

    await db().exec('DELETE FROM pr_files');
    await db().exec('DELETE FROM pr_review_comments');

    const rest = await workspaceWithRepo();
    await db().transaction((tx) =>
      persistPullRequest(tx, {
        ...rest,
        pullRequest: mapRestPullRequest(restPullRequest()),
        source: 'rest_incremental',
      }),
    );

    expect(await files()).toEqual(fromGraphQL);
    const restComments = await db().query<{ node_id: string }>(
      'SELECT node_id FROM pr_review_comments ORDER BY node_id',
    );
    expect(restComments.rows).toEqual(graphQLComments.rows);
  });

  it('records per-commit statistics from the REST path', async () => {
    const scope = await workspaceWithRepo();
    await db().transaction((tx) =>
      persistPullRequest(tx, {
        ...scope,
        pullRequest: mapRestPullRequest(restPullRequest()),
        source: 'rest_incremental',
      }),
    );

    const { rows } = await db().query<{ path: string; additions: number }>(
      'SELECT path, additions FROM pr_commit_files ORDER BY path',
    );
    expect(rows).toEqual([
      { path: 'src/limiter.ts', additions: 100 },
      { path: 'src/server.ts', additions: 20 },
    ]);
  });

  it('creates no rows and changes no values when the same file list arrives twice', async () => {
    const scope = await workspaceWithRepo();
    const persist = () =>
      db().transaction((tx) =>
        persistPullRequest(tx, {
          ...scope,
          pullRequest: mapGraphQLPullRequest(graphqlPullRequest()),
          source: 'graphql_backfill',
        }),
      );

    await persist();
    const before = await db().query('SELECT * FROM pr_files ORDER BY path');
    await persist();
    const after = await db().query('SELECT * FROM pr_files ORDER BY path');

    expect(after.rows).toEqual(before.rows);
  });

  it('retires a file that a later ingestion no longer reports', async () => {
    const scope = await workspaceWithRepo();
    await db().transaction((tx) =>
      persistPullRequest(tx, {
        ...scope,
        pullRequest: mapGraphQLPullRequest(graphqlPullRequest()),
        source: 'graphql_backfill',
      }),
    );

    const shrunk = mapGraphQLPullRequest(graphqlPullRequest());
    shrunk.files = [{ path: 'src/limiter.ts', additions: 100, deletions: 0, changeKind: 'added' }];
    await db().transaction((tx) =>
      persistPullRequest(tx, { ...scope, pullRequest: shrunk, source: 'graphql_backfill' }),
    );

    expect((await files()).map((row) => row.path)).toEqual(['src/limiter.ts']);
  });

  it('pages a file list until it is complete', async () => {
    const scope = await workspaceWithRepo();
    const node = graphqlPullRequest();
    node.files = {
      totalCount: 3,
      pageInfo: { hasNextPage: true, endCursor: 'files-1' },
      nodes: [{ path: 'a.ts', additions: 1, deletions: 0, changeType: 'ADDED' }],
    };

    const graphql = {
      fetchPullRequestPage: async (): Promise<PullRequestPage> => ({
        nodes: [node],
        endCursor: null,
        hasNextPage: false,
        rateLimit: undefined,
      }),
      fetchPullRequestFiles: async (input: { after?: string | null }) =>
        input.after === 'files-1'
          ? {
              nodes: [{ path: 'b.ts', additions: 2, deletions: 0, changeType: 'ADDED' }],
              totalCount: 3,
              endCursor: 'files-2',
              hasNextPage: true,
            }
          : {
              nodes: [{ path: 'c.ts', additions: 3, deletions: 0, changeType: 'MODIFIED' }],
              totalCount: 3,
              endCursor: null,
              hasNextPage: false,
            },
    } as unknown as GitHubGraphQLClient;

    await runBackfill(db(), scope, {
      graphql,
      rateLimit: new RateLimitTracker(100),
      backfillWindowDays: 90,
      now,
    });

    expect((await files()).map((row) => row.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    const { rows } = await db().query<{ files_truncated: boolean }>(
      'SELECT files_truncated FROM pull_requests',
    );
    expect(rows[0]!.files_truncated).toBe(false);
  });

  it('marks a file list GitHub will not enumerate as truncated rather than complete', async () => {
    const scope = await workspaceWithRepo();
    const node = graphqlPullRequest();
    node.files = {
      totalCount: 4000,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ path: 'a.ts', additions: 1, deletions: 0, changeType: 'ADDED' }],
    };

    await db().transaction((tx) =>
      persistPullRequest(tx, {
        ...scope,
        pullRequest: mapGraphQLPullRequest(node),
        source: 'graphql_backfill',
      }),
    );

    const { rows } = await db().query<{ files_truncated: boolean }>(
      'SELECT files_truncated FROM pull_requests',
    );
    expect(rows[0]!.files_truncated).toBe(true);
  });
});

describe('the file fill-in pass', () => {
  /** A fake pair that answers file, comment, and commit-detail requests for any pull request. */
  function fillInDeps(options: { failAfter?: number } = {}) {
    let served = 0;
    return {
      graphql: {
        fetchPullRequestFiles: async () => {
          served++;
          if (options.failAfter !== undefined && served > options.failAfter) {
            throw new Error('GitHub went away mid-pass');
          }
          return {
            nodes: [{ path: 'src/a.ts', additions: 5, deletions: 1, changeType: 'MODIFIED' }],
            totalCount: 1,
            endCursor: null,
            hasNextPage: false,
          };
        },
        fetchPullRequestReviewComments: async () => ({ reviews: null, reviewThreads: null }),
      } as unknown as GitHubGraphQLClient,
      rest: { getCommit: async () => ({}) } as unknown as GitHubRestClient,
      rateLimit: new RateLimitTracker(100),
    };
  }

  async function seedUnfilled(scope: { workspaceId: string; repositoryId: string }, count: number) {
    for (let i = 0; i < count; i++) {
      await db().query(
        `INSERT INTO pull_requests
           (workspace_id, repository_id, node_id, number, state, opened_at, merged_at,
            github_updated_at)
         VALUES ($1,$2,$3,$4,'merged', now() - INTERVAL '1 day', now(), now())`,
        [scope.workspaceId, scope.repositoryId, `PR_fill_${i}`, i + 1],
      );
    }
  }

  it('resumes at the pull requests it never reached rather than restarting', async () => {
    const scope = await workspaceWithRepo();
    await seedUnfilled(scope, 3);

    // The first run dies after one pull request; its progress is already committed.
    await expect(runFileFillIn(db(), scope, fillInDeps({ failAfter: 1 }))).rejects.toThrow(
      'GitHub went away mid-pass',
    );
    const afterFailure = await db().query<{ count: number }>(
      'SELECT count(*)::int AS count FROM pull_requests WHERE files_ingested_at IS NOT NULL',
    );
    expect(afterFailure.rows[0]!.count).toBe(1);

    const resumed = await runFileFillIn(db(), scope, fillInDeps());

    // Two left, not three: the marker is monotone, so the pass cannot loop on the same rows.
    expect(resumed.pullRequests).toBe(2);
    expect(resumed.complete).toBe(true);
    const runs = await db().query<{ kind: string; status: string }>(
      "SELECT kind, status FROM sync_runs WHERE kind = 'file_fill_in' ORDER BY started_at",
    );
    expect(runs.rows.map((row) => row.status)).toEqual(['failed', 'succeeded']);
  });

  it('extends churn coverage backwards as it fills', async () => {
    const scope = await workspaceWithRepo();
    await seedUnfilled(scope, 1);

    expect(await listCoverage(db(), scope.workspaceId, { dataClass: 'file_diffs' })).toHaveLength(0);
    await runFileFillIn(db(), scope, fillInDeps());

    const coverage = await listCoverage(db(), scope.workspaceId, { dataClass: 'file_diffs' });
    expect(coverage).toHaveLength(1);
    expect(coverage[0]!.coveredFrom).not.toBeNull();
  });
});

describe('default-branch commit ingestion', () => {
  it('resolves a commit reachable through both a pull request and the branch to one record', async () => {
    const scope = await workspaceWithRepo();
    const author = await seedContributor(db(), scope.workspaceId, { login: 'ada' });
    await db().transaction((tx) =>
      persistPullRequest(tx, {
        ...scope,
        pullRequest: mapGraphQLPullRequest(graphqlPullRequest()),
        source: 'graphql_backfill',
      }),
    );

    const shared = {
      oid: 'sha_PR_1',
      nodeId: 'C_PR_1',
      author: null,
      committedAt: new Date('2026-04-01T10:00:00.000Z'),
      additions: 100,
      deletions: 20,
      changedFiles: 2,
      messageHeadline: 'Add limiter',
    };

    await db().transaction((tx) =>
      persistRepositoryCommits(tx, { ...scope, commits: [shared, shared] }),
    );

    const { rows } = await db().query<{ oid: string; pull_request_id: string | null }>(
      'SELECT oid, pull_request_id FROM repository_commits',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pull_request_id).not.toBeNull();
    expect(author.id).toBeTruthy();
  });

  it('records a commit pushed straight to the branch without creating a pull request', async () => {
    const scope = await workspaceWithRepo();
    await db().transaction((tx) =>
      persistRepositoryCommits(tx, {
        ...scope,
        commits: [
          {
            oid: 'direct-1',
            nodeId: 'C_direct',
            author: null,
            committedAt: new Date('2026-04-02T10:00:00.000Z'),
            additions: 3,
            deletions: 1,
            changedFiles: 1,
            messageHeadline: 'Fix typo',
          },
        ],
      }),
    );

    const commits = await db().query('SELECT id FROM repository_commits');
    const pulls = await db().query('SELECT id FROM pull_requests');
    expect(commits.rows).toHaveLength(1);
    expect(pulls.rows).toHaveLength(0);
  });
});
