import { describe, expect, it } from 'vitest';
import { databaseFixture } from '../helpers/db';
import { seedRepository, seedWorkspace } from '../helpers/factories';
import { graphqlPullRequest, restPullRequest, iso } from '../helpers/github-fixtures';
import { mapGraphQLPullRequest } from '../../src/ingest/graphql-map';
import { mapRestPullRequest } from '../../src/ingest/rest-map';
import { persistPullRequest } from '../../src/ingest/normalize';
import { reprocessFromRaw } from '../../src/ingest/reprocess';
import { countJobs } from '../../src/jobs/queue';

const db = databaseFixture();

async function workspaceWithRepo() {
  const workspace = await seedWorkspace(db());
  const repository = await seedRepository(db(), workspace.id, { name: 'api' });
  return { workspaceId: workspace.id, repositoryId: repository.id };
}

async function snapshot(table: string, columns: string) {
  const { rows } = await db().query(`SELECT ${columns} FROM ${table} ORDER BY 1`);
  return rows;
}

describe('normalizer', () => {
  it('anchors first_commit_at on the author date, so a rebase does not erase coding time', async () => {
    const { workspaceId, repositoryId } = await workspaceWithRepo();
    // The shape a rebase leaves behind: the work was written 20 hours before T0, then replayed
    // onto the default branch an hour after it, moments before the pull request was opened.
    const payload = graphqlPullRequest();
    const commit = payload.commits!.nodes[0]!.commit;
    commit.authoredDate = iso(-20);
    commit.committedDate = iso(1);

    await db().transaction((tx) =>
      persistPullRequest(tx, {
        workspaceId,
        repositoryId,
        pullRequest: mapGraphQLPullRequest(payload),
        source: 'graphql_backfill',
        rawPayload: payload,
      }),
    );

    const pr = (
      await db().query<{ first_commit_at: Date }>('SELECT first_commit_at FROM pull_requests')
    ).rows[0]!;
    expect(pr.first_commit_at.toISOString()).toBe(iso(-20));
  });

  it('falls back to the committer date when a commit carries no author date', async () => {
    const { workspaceId, repositoryId } = await workspaceWithRepo();
    const payload = graphqlPullRequest();
    const commit = payload.commits!.nodes[0]!.commit;
    commit.authoredDate = null;
    commit.committedDate = iso(1);

    await db().transaction((tx) =>
      persistPullRequest(tx, {
        workspaceId,
        repositoryId,
        pullRequest: mapGraphQLPullRequest(payload),
        source: 'graphql_backfill',
        rawPayload: payload,
      }),
    );

    const pr = (
      await db().query<{ first_commit_at: Date }>('SELECT first_commit_at FROM pull_requests')
    ).rows[0]!;
    expect(pr.first_commit_at.toISOString()).toBe(iso(1));
  });

  it('writes a pull request with its reviews, commits, and events', async () => {
    const { workspaceId, repositoryId } = await workspaceWithRepo();
    const normalized = mapGraphQLPullRequest(graphqlPullRequest());

    const result = await db().transaction((tx) =>
      persistPullRequest(tx, {
        workspaceId,
        repositoryId,
        pullRequest: normalized,
        source: 'graphql_backfill',
        rawPayload: graphqlPullRequest(),
      }),
    );

    expect(result.created).toBe(true);
    const pr = (
      await db().query<{
        title: string;
        state: string;
        ready_for_review_at: Date;
        merged_at: Date;
        additions: number;
      }>('SELECT * FROM pull_requests')
    ).rows[0]!;
    expect(pr.state).toBe('merged');
    expect(pr.ready_for_review_at.toISOString()).toBe(iso(2));
    expect(pr.merged_at.toISOString()).toBe(iso(8));
    expect(pr.additions).toBe(120);

    expect((await db().query('SELECT id FROM pr_reviews')).rows).toHaveLength(1);
    expect((await db().query('SELECT id FROM pr_commits')).rows).toHaveLength(1);
    // ready_for_review plus the commit-as-push event
    expect((await db().query('SELECT id FROM pr_events')).rows).toHaveLength(2);
    expect((await db().query('SELECT id FROM contributors')).rows).toHaveLength(2);
    // Analysis is queued in the same transaction as the data (design.md D11).
    expect(await countJobs(db(), { workspaceId, type: 'pull_request.analyze' })).toBe(1);
  });

  it('classifies a bot author at ingest', async () => {
    const { workspaceId, repositoryId } = await workspaceWithRepo();
    const normalized = mapGraphQLPullRequest(graphqlPullRequest({ authorIsBot: true }));

    await db().transaction((tx) =>
      persistPullRequest(tx, {
        workspaceId,
        repositoryId,
        pullRequest: normalized,
        source: 'graphql_backfill',
      }),
    );

    const { rows } = await db().query<{ login: string; is_bot: boolean }>(
      'SELECT login, is_bot FROM contributors ORDER BY login',
    );
    expect(rows.find((row) => row.login === 'dependabot')?.is_bot).toBe(true);
    expect(rows.find((row) => row.login === 'bob')?.is_bot).toBe(false);
  });

  it('replaying the same payload changes nothing', async () => {
    const { workspaceId, repositoryId } = await workspaceWithRepo();
    const payload = graphqlPullRequest();
    const persist = () =>
      db().transaction((tx) =>
        persistPullRequest(tx, {
          workspaceId,
          repositoryId,
          pullRequest: mapGraphQLPullRequest(payload),
          source: 'graphql_backfill',
          rawPayload: payload,
        }),
      );

    await persist();
    const before = {
      pullRequests: await snapshot('pull_requests', '*'),
      reviews: await snapshot('pr_reviews', '*'),
      commits: await snapshot('pr_commits', '*'),
      events: await snapshot('pr_events', '*'),
      contributors: await snapshot('contributors', '*'),
      raw: await snapshot('github_raw_events', 'id, payload_hash'),
    };

    await persist();
    const after = {
      pullRequests: await snapshot('pull_requests', '*'),
      reviews: await snapshot('pr_reviews', '*'),
      commits: await snapshot('pr_commits', '*'),
      events: await snapshot('pr_events', '*'),
      contributors: await snapshot('contributors', '*'),
      raw: await snapshot('github_raw_events', 'id, payload_hash'),
    };

    expect(after).toEqual(before);
  });

  it('applies a genuine change on the second ingestion', async () => {
    const { workspaceId, repositoryId } = await workspaceWithRepo();
    const open = graphqlPullRequest({ mergedAtHours: null, updatedAtHours: 3 });
    await db().transaction((tx) =>
      persistPullRequest(tx, {
        workspaceId,
        repositoryId,
        pullRequest: mapGraphQLPullRequest(open),
        source: 'graphql_backfill',
        rawPayload: open,
      }),
    );
    expect(
      (await db().query<{ state: string }>('SELECT state FROM pull_requests')).rows[0]!.state,
    ).toBe('open');

    const merged = graphqlPullRequest();
    await db().transaction((tx) =>
      persistPullRequest(tx, {
        workspaceId,
        repositoryId,
        pullRequest: mapGraphQLPullRequest(merged),
        source: 'rest_incremental',
        rawPayload: merged,
      }),
    );

    const row = (
      await db().query<{ state: string; merged_at: Date }>(
        'SELECT state, merged_at FROM pull_requests',
      )
    ).rows[0]!;
    expect(row.state).toBe('merged');
    expect(row.merged_at.toISOString()).toBe(iso(8));
    expect((await db().query('SELECT id FROM pull_requests')).rows).toHaveLength(1);
  });

  it('produces the same record whichever client ingested it', async () => {
    const viaGraphql = await workspaceWithRepo();
    const viaRest = await workspaceWithRepo();

    await db().transaction((tx) =>
      persistPullRequest(tx, {
        ...viaGraphql,
        pullRequest: mapGraphQLPullRequest(graphqlPullRequest()),
        source: 'graphql_backfill',
      }),
    );
    await db().transaction((tx) =>
      persistPullRequest(tx, {
        ...viaRest,
        pullRequest: mapRestPullRequest(restPullRequest()),
        source: 'rest_incremental',
      }),
    );

    const compare = async (table: string, columns: string, workspaceId: string) => {
      const { rows } = await db().query(
        `SELECT ${columns} FROM ${table} WHERE workspace_id = $1 ORDER BY 1`,
        [workspaceId],
      );
      return rows;
    };

    const prColumns =
      'node_id, number, title, url, state, is_draft, base_ref, head_ref, additions, deletions, ' +
      'changed_files, opened_at, ready_for_review_at, first_commit_at, closed_at, merged_at, ' +
      'github_updated_at';
    expect(await compare('pull_requests', prColumns, viaRest.workspaceId)).toEqual(
      await compare('pull_requests', prColumns, viaGraphql.workspaceId),
    );
    expect(
      await compare(
        'pr_reviews',
        'node_id, state, body_present, submitted_at',
        viaRest.workspaceId,
      ),
    ).toEqual(
      await compare(
        'pr_reviews',
        'node_id, state, body_present, submitted_at',
        viaGraphql.workspaceId,
      ),
    );
    expect(
      await compare('pr_events', 'event_type, occurred_at, dedupe_key', viaRest.workspaceId),
    ).toEqual(
      await compare('pr_events', 'event_type, occurred_at, dedupe_key', viaGraphql.workspaceId),
    );
    // Commits agree on everything REST reports; REST's commit list carries no per-commit file
    // count, which is why the backfill path uses GraphQL.
    expect(
      await compare(
        'pr_commits',
        'node_id, oid, additions, deletions, committed_at',
        viaRest.workspaceId,
      ),
    ).toEqual(
      await compare(
        'pr_commits',
        'node_id, oid, additions, deletions, committed_at',
        viaGraphql.workspaceId,
      ),
    );
    expect(await compare('contributors', 'node_id, login, is_bot', viaRest.workspaceId)).toEqual(
      await compare('contributors', 'node_id, login, is_bot', viaGraphql.workspaceId),
    );
  });

  it('rebuilds normalized records from retained payloads without GitHub', async () => {
    const { workspaceId, repositoryId } = await workspaceWithRepo();
    const payload = graphqlPullRequest();
    await db().transaction((tx) =>
      persistPullRequest(tx, {
        workspaceId,
        repositoryId,
        pullRequest: mapGraphQLPullRequest(payload),
        source: 'graphql_backfill',
        rawPayload: payload,
      }),
    );

    // A normalization defect: the title was stored wrongly.
    await db().query("UPDATE pull_requests SET title = 'corrupted', additions = NULL");

    const outcome = await reprocessFromRaw(db(), { workspaceId });

    expect(outcome).toEqual({ pullRequests: 1, skipped: 0 });
    const row = (
      await db().query<{ title: string; additions: number }>(
        'SELECT title, additions FROM pull_requests',
      )
    ).rows[0]!;
    expect(row.title).toBe('Add rate limiting');
    expect(row.additions).toBe(120);
    // Reprocessing reads raw storage; it must not write a second copy of it.
    expect((await db().query('SELECT id FROM github_raw_events')).rows).toHaveLength(1);
  });
});
