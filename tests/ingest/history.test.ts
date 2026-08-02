/**
 * History sync (spec: github-data-sync "Members can request a history sync over a chosen range",
 * "Deepening extends coverage without refetching what is present").
 *
 * The walk is ordered by creation date descending, so these fixtures hand back pages of pull
 * requests getting steadily older, exactly as GitHub would.
 */
import { describe, expect, it } from 'vitest';
import { databaseFixture } from '../helpers/db';
import { seedRepository, seedWorkspace } from '../helpers/factories';
import { graphqlPullRequest, T0 } from '../helpers/github-fixtures';
import {
  HISTORY_PAGES_PER_RUN,
  requestHistorySync,
  runHistorySync,
} from '../../src/ingest/history';
import { getRepository } from '../../src/repositories/store';
import { RateLimitTracker } from '../../src/github/rate-limit';
import { RetryableError } from '../../src/jobs/errors';
import { countJobs } from '../../src/jobs/queue';
import type { GitHubGraphQLClient, PullRequestPage } from '../../src/github/graphql';

const db = databaseFixture();

const NOW = new Date('2026-04-10T09:00:00.000Z');
const now = () => NOW;
const hoursBeforeT0 = (hours: number) => new Date(T0.getTime() - hours * 3600_000);

/** Pages of pull requests ordered by creation date, newest first. */
class FakeGraphQL {
  calls: (string | null | undefined)[] = [];
  failOnCall: number | undefined;

  constructor(private readonly pages: PullRequestPage[]) {}

  async fetchPullRequestPageByCreation(input: { after?: string | null }): Promise<PullRequestPage> {
    this.calls.push(input.after);
    if (this.failOnCall === this.calls.length) throw new Error('GitHub went away mid-walk');
    const index = input.after ? Number(input.after.replace('cursor-', '')) : 0;
    const page = this.pages[index];
    if (!page) throw new Error(`no page at index ${index}`);
    return page;
  }
}

/** One page whose pull requests were created `createdAtHours` before T0. */
function page(
  nodeIds: string[],
  index: number,
  hasNextPage: boolean,
  createdAtHours: number,
): PullRequestPage {
  return {
    nodes: nodeIds.map((nodeId, i) =>
      graphqlPullRequest({
        nodeId,
        number: index * 10 + i,
        createdAtHours: -(createdAtHours + i),
        mergedAtHours: 8,
      }),
    ),
    endCursor: `cursor-${index + 1}`,
    hasNextPage,
    rateLimit: undefined,
  };
}

const openTracker = () => new RateLimitTracker(100);

function deps(graphql: FakeGraphQL, rateLimit = openTracker()) {
  return {
    graphql: graphql as unknown as GitHubGraphQLClient,
    rateLimit,
    now,
  };
}

async function fixture(overrides: Parameters<typeof seedRepository>[2] = {}) {
  const workspace = await seedWorkspace(db());
  const repository = await seedRepository(db(), workspace.id, {
    name: 'api',
    backfillState: 'complete',
    ...overrides,
  });
  return { workspaceId: workspace.id, repositoryId: repository.id };
}

describe('history sync', () => {
  it('runs an unbounded request to the repository’s first pull request', async () => {
    const { workspaceId, repositoryId } = await fixture();
    const graphql = new FakeGraphQL([page(['PR_a'], 0, true, 10), page(['PR_b'], 1, false, 100)]);

    const outcome = await runHistorySync(
      db(),
      { workspaceId, repositoryId, from: null },
      deps(graphql),
    );

    expect(outcome).toMatchObject({ pullRequests: 2, complete: true, reachedEnd: true });
    const stored = (await getRepository(db(), repositoryId))!;
    expect(stored.historyComplete).toBe(true);
    expect(stored.historyState).toBe('complete');
    expect(stored.historyCoveredFrom).toEqual(hoursBeforeT0(100));
    // Nothing older can exist, so the cursor is spent.
    expect(stored.historyCursor).toBeNull();
    const runs = await db().query<{ kind: string; status: string }>(
      'SELECT kind, status FROM sync_runs',
    );
    expect(runs.rows[0]).toMatchObject({ kind: 'history', status: 'succeeded' });
  });

  it('stops a bounded request at the requested date and claims exactly that much', async () => {
    const { workspaceId, repositoryId } = await fixture();
    const graphql = new FakeGraphQL([
      page(['PR_recent'], 0, true, 10),
      page(['PR_ancient'], 1, true, 500),
    ]);
    const from = hoursBeforeT0(100);

    const outcome = await runHistorySync(db(), { workspaceId, repositoryId, from }, deps(graphql));

    // The second page's pull request predates the request, so it is neither stored nor claimed.
    expect(outcome).toMatchObject({ pullRequests: 1, complete: true, reachedEnd: false });
    const stored = (await getRepository(db(), repositoryId))!;
    expect(stored.historyCoveredFrom).toEqual(from);
    expect(stored.historyComplete).toBe(false);
    // The cursor survives, so a later, deeper request resumes here rather than re-walking.
    expect(stored.historyCursor).toBe('cursor-2');
    expect((await db().query('SELECT id FROM pull_requests')).rows).toHaveLength(1);
  });

  it('resumes from its cursor after an interruption and creates no duplicates', async () => {
    const { workspaceId, repositoryId } = await fixture();
    const graphql = new FakeGraphQL([
      page(['PR_1'], 0, true, 10),
      page(['PR_2'], 1, true, 20),
      page(['PR_3'], 2, false, 30),
    ]);
    graphql.failOnCall = 2;

    await expect(
      runHistorySync(db(), { workspaceId, repositoryId, from: null }, deps(graphql)),
    ).rejects.toThrow('GitHub went away mid-walk');

    const afterFailure = (await getRepository(db(), repositoryId))!;
    expect(afterFailure.historyCursor).toBe('cursor-1');
    expect(afterFailure.historyState).toBe('failed');
    expect(afterFailure.historyCoveredFrom).toEqual(hoursBeforeT0(10));
    expect((await db().query('SELECT id FROM pull_requests')).rows).toHaveLength(1);

    graphql.failOnCall = undefined;
    const resumed = await runHistorySync(
      db(),
      { workspaceId, repositoryId, from: null },
      deps(graphql),
    );

    // The first page is never fetched twice, and each pull request is stored exactly once.
    expect(graphql.calls).toEqual([null, 'cursor-1', 'cursor-1', 'cursor-2']);
    expect(resumed.complete).toBe(true);
    expect((await db().query('SELECT id FROM pull_requests')).rows).toHaveLength(3);
    expect((await getRepository(db(), repositoryId))!.historyState).toBe('complete');
  });

  it('ingests only the older pull requests when deepening an already-backfilled repository', async () => {
    // Backfilled under the default window: everything created since then is already present.
    const coveredFrom = hoursBeforeT0(20);
    const { workspaceId, repositoryId } = await fixture({ historyCoveredFrom: coveredFrom });
    const graphql = new FakeGraphQL([
      page(['PR_known_a', 'PR_known_b'], 0, true, 5),
      page(['PR_older'], 1, false, 200),
    ]);

    const outcome = await runHistorySync(
      db(),
      { workspaceId, repositoryId, from: null },
      deps(graphql),
    );

    expect(outcome.skipped).toBe(2);
    expect(outcome.pullRequests).toBe(1);
    const stored = await db().query<{ node_id: string }>('SELECT node_id FROM pull_requests');
    expect(stored.rows.map((row) => row.node_id)).toEqual(['PR_older']);
    expect((await getRepository(db(), repositoryId))!.historyCoveredFrom).toEqual(
      hoursBeforeT0(200),
    );
  });

  it('does no work at all when the requested range is already covered', async () => {
    const { workspaceId, repositoryId } = await fixture({
      historyCoveredFrom: hoursBeforeT0(500),
    });
    const graphql = new FakeGraphQL([]);

    const outcome = await runHistorySync(
      db(),
      { workspaceId, repositoryId, from: hoursBeforeT0(100) },
      deps(graphql),
    );

    expect(outcome).toMatchObject({ alreadyCovered: true, pagesFetched: 0, pullRequests: 0 });
    expect(graphql.calls).toEqual([]);
    expect((await db().query('SELECT id FROM sync_runs')).rows).toHaveLength(0);
  });

  it('continues in a follow-up job when a run hits its page budget', async () => {
    const { workspaceId, repositoryId } = await fixture();
    const graphql = new FakeGraphQL(
      Array.from({ length: HISTORY_PAGES_PER_RUN + 2 }, (_, index) =>
        page([`PR_${index}`], index, true, 10 * (index + 1)),
      ),
    );

    const outcome = await runHistorySync(
      db(),
      { workspaceId, repositoryId, from: null },
      deps(graphql),
    );

    expect(outcome.complete).toBe(false);
    expect(outcome.pagesFetched).toBe(HISTORY_PAGES_PER_RUN);
    expect(
      await countJobs(db(), { workspaceId, type: 'repository.history_sync', state: 'pending' }),
    ).toBe(1);
    expect((await getRepository(db(), repositoryId))!.historyState).toBe('running');
  });

  it('marks a rate limit pause as paused, not failed, with its progress recorded', async () => {
    const { workspaceId, repositoryId } = await fixture();
    const tracker = new RateLimitTracker(500);
    const graphql = new FakeGraphQL([page(['PR_1'], 0, true, 10), page(['PR_2'], 1, false, 20)]);
    const throttled = {
      fetchPullRequestPageByCreation: async (input: { after?: string | null }) => {
        const result = await graphql.fetchPullRequestPageByCreation(input);
        // After the first page, quota is nearly gone.
        tracker.observe({
          limit: 5000,
          remaining: 100,
          resetAt: new Date(NOW.getTime() + 600_000),
          observedAt: NOW,
        });
        return result;
      },
    } as unknown as GitHubGraphQLClient;

    await expect(
      runHistorySync(
        db(),
        { workspaceId, repositoryId, from: null },
        { graphql: throttled, rateLimit: tracker, now },
      ),
    ).rejects.toBeInstanceOf(RetryableError);

    const stored = (await getRepository(db(), repositoryId))!;
    expect(stored.historyState).toBe('paused');
    expect(stored.historyCursor).toBe('cursor-1');
    expect(stored.historyCoveredFrom).toEqual(hoursBeforeT0(10));
    expect((await db().query('SELECT id FROM pull_requests')).rows).toHaveLength(1);
    const runs = await db().query<{ status: string }>('SELECT status FROM sync_runs');
    expect(runs.rows.map((row) => row.status)).toEqual(['paused']);
  });

  it('does not touch synced_through, which belongs to incremental sync', async () => {
    const syncedThrough = new Date('2026-04-09T09:00:00.000Z');
    const { workspaceId, repositoryId } = await fixture({ syncedThrough });
    const graphql = new FakeGraphQL([page(['PR_a'], 0, false, 10)]);

    await runHistorySync(db(), { workspaceId, repositoryId, from: null }, deps(graphql));

    expect((await getRepository(db(), repositoryId))!.syncedThrough).toEqual(syncedThrough);
  });
});

describe('requesting a history sync for a workspace', () => {
  it('fans out one job per in-scope repository and reports each outcome', async () => {
    const workspace = await seedWorkspace(db());
    const fresh = await seedRepository(db(), workspace.id, { name: 'fresh' });
    const deep = await seedRepository(db(), workspace.id, {
      name: 'deep',
      historyComplete: true,
    });
    await seedRepository(db(), workspace.id, { name: 'dropped', inScope: false });

    const outcome = await requestHistorySync(db(), workspace.id, null);

    expect(outcome.enqueued).toBe(1);
    expect(outcome.repositories).toEqual([
      expect.objectContaining({ repositoryId: deep.id, status: 'already_covered' }),
      expect.objectContaining({ repositoryId: fresh.id, status: 'enqueued' }),
    ]);
  });

  it('reports a repeat request as already running rather than enqueueing twice', async () => {
    const workspace = await seedWorkspace(db());
    await seedRepository(db(), workspace.id, { name: 'api' });

    await requestHistorySync(db(), workspace.id, null);
    const second = await requestHistorySync(db(), workspace.id, null);

    expect(second.enqueued).toBe(0);
    expect(second.repositories[0]!.status).toBe('already_running');
    expect(
      await countJobs(db(), {
        workspaceId: workspace.id,
        type: 'repository.history_sync',
        state: 'pending',
      }),
    ).toBe(1);
  });
});
