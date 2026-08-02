import { describe, expect, it } from 'vitest';
import { databaseFixture } from '../helpers/db';
import { seedRepository, seedWorkspace } from '../helpers/factories';
import { graphqlPullRequest, restPullRequest, T0 } from '../helpers/github-fixtures';
import { runBackfill, PAGES_PER_RUN } from '../../src/ingest/backfill';
import {
  enqueueWorkspaceSyncs,
  requestOnDemandSync,
  runIncrementalSync,
} from '../../src/ingest/incremental';
import { getRepository } from '../../src/repositories/store';
import { RateLimitTracker } from '../../src/github/rate-limit';
import { RetryableError } from '../../src/jobs/errors';
import { countJobs } from '../../src/jobs/queue';
import type { GitHubGraphQLClient, PullRequestPage } from '../../src/github/graphql';
import type { GitHubRestClient } from '../../src/github/rest';

const db = databaseFixture();

const NOW = new Date('2026-04-10T09:00:00.000Z');
const now = () => NOW;

/** Pages of pull requests, ordered most-recently-updated first, as GitHub returns them. */
class FakeGraphQL {
  calls: (string | null | undefined)[] = [];
  failOnCall: number | undefined;

  constructor(private readonly pages: PullRequestPage[]) {}

  async fetchPullRequestPage(input: { after?: string | null }): Promise<PullRequestPage> {
    this.calls.push(input.after);
    if (this.failOnCall === this.calls.length) throw new Error('GitHub went away mid-backfill');
    const index = input.after ? Number(input.after.replace('cursor-', '')) : 0;
    const page = this.pages[index];
    if (!page) throw new Error(`no page at index ${index}`);
    return page;
  }
}

function page(nodeIds: string[], index: number, hasNextPage: boolean, updatedAtHours = 0) {
  return {
    nodes: nodeIds.map((nodeId, i) =>
      graphqlPullRequest({
        nodeId,
        number: index * 10 + i,
        updatedAtHours,
        mergedAtHours: updatedAtHours,
      }),
    ),
    endCursor: `cursor-${index + 1}`,
    hasNextPage,
    rateLimit: undefined,
  } as PullRequestPage;
}

async function fixture() {
  const workspace = await seedWorkspace(db());
  const repository = await seedRepository(db(), workspace.id, {
    name: 'api',
    backfillState: 'pending',
  });
  return { workspaceId: workspace.id, repositoryId: repository.id };
}

const openTracker = () => new RateLimitTracker(100);

describe('backfill', () => {
  it('ingests the window and marks the repository complete', async () => {
    const { workspaceId, repositoryId } = await fixture();
    const graphql = new FakeGraphQL([page(['PR_a', 'PR_b'], 0, false, 0)]);

    const outcome = await runBackfill(
      db(),
      { workspaceId, repositoryId },
      {
        graphql: graphql as unknown as GitHubGraphQLClient,
        rateLimit: openTracker(),
        backfillWindowDays: 90,
        now,
      },
    );

    expect(outcome).toMatchObject({ pullRequests: 2, complete: true });
    expect((await getRepository(db(), repositoryId))!.backfillState).toBe('complete');
    const runs = await db().query<{ status: string; pull_requests_seen: number }>(
      'SELECT status, pull_requests_seen FROM sync_runs',
    );
    expect(runs.rows[0]).toMatchObject({ status: 'succeeded', pull_requests_seen: 2 });
  });

  it('stops at the edge of the backfill window', async () => {
    const { workspaceId, repositoryId } = await fixture();
    // T0 is nine days before NOW; a 3-day window excludes it.
    const graphql = new FakeGraphQL([page(['PR_old'], 0, true, 0)]);

    const outcome = await runBackfill(
      db(),
      { workspaceId, repositoryId },
      {
        graphql: graphql as unknown as GitHubGraphQLClient,
        rateLimit: openTracker(),
        backfillWindowDays: 3,
        now,
      },
    );

    expect(outcome.pullRequests).toBe(0);
    expect(outcome.complete).toBe(true);
    expect(T0.getTime()).toBeLessThan(NOW.getTime());
  });

  it('resumes at the recorded cursor after an interruption', async () => {
    const { workspaceId, repositoryId } = await fixture();
    const pages = [
      page(['PR_1'], 0, true, 0),
      page(['PR_2'], 1, true, 0),
      page(['PR_3'], 2, false, 0),
    ];
    const graphql = new FakeGraphQL(pages);
    graphql.failOnCall = 2;

    const deps = {
      graphql: graphql as unknown as GitHubGraphQLClient,
      rateLimit: openTracker(),
      backfillWindowDays: 90,
      now,
    };

    await expect(runBackfill(db(), { workspaceId, repositoryId }, deps)).rejects.toThrow(
      'GitHub went away mid-backfill',
    );

    const afterFailure = (await getRepository(db(), repositoryId))!;
    expect(afterFailure.backfillCursor).toBe('cursor-1');
    expect(afterFailure.backfillState).toBe('in_progress');
    expect((await db().query('SELECT id FROM pull_requests')).rows).toHaveLength(1);

    graphql.failOnCall = undefined;
    const resumed = await runBackfill(db(), { workspaceId, repositoryId }, deps);

    // Resumed at the page that failed rather than restarting the repository: the first page is
    // never fetched twice.
    expect(graphql.calls).toEqual([null, 'cursor-1', 'cursor-1', 'cursor-2']);
    expect(resumed.complete).toBe(true);
    expect((await db().query('SELECT id FROM pull_requests')).rows).toHaveLength(3);
    const failed = await db().query<{ status: string }>(
      "SELECT status FROM sync_runs WHERE status = 'failed'",
    );
    expect(failed.rows).toHaveLength(1);
  });

  it('continues in a follow-up job when a run hits its page budget', async () => {
    const { workspaceId, repositoryId } = await fixture();
    const pages = Array.from({ length: PAGES_PER_RUN + 2 }, (_, index) =>
      page([`PR_${index}`], index, true, 0),
    );
    const graphql = new FakeGraphQL(pages);

    const outcome = await runBackfill(
      db(),
      { workspaceId, repositoryId },
      {
        graphql: graphql as unknown as GitHubGraphQLClient,
        rateLimit: openTracker(),
        backfillWindowDays: 90,
        now,
      },
    );

    expect(outcome.complete).toBe(false);
    expect(outcome.pagesFetched).toBe(PAGES_PER_RUN);
    expect(
      await countJobs(db(), { workspaceId, type: 'repository.backfill', state: 'pending' }),
    ).toBe(1);
    const runs = await db().query<{ status: string }>('SELECT status FROM sync_runs');
    expect(runs.rows[0]!.status).toBe('paused');
  });

  it('pauses below the rate limit safety threshold without losing progress', async () => {
    const { workspaceId, repositoryId } = await fixture();
    const graphql = new FakeGraphQL([page(['PR_1'], 0, true, 0), page(['PR_2'], 1, false, 0)]);
    const tracker = new RateLimitTracker(500);

    const deps = {
      graphql: {
        fetchPullRequestPage: async (input: { after?: string | null }) => {
          const result = await graphql.fetchPullRequestPage(input);
          // After the first page, quota is nearly gone.
          tracker.observe({
            limit: 5000,
            remaining: 100,
            resetAt: new Date(NOW.getTime() + 600_000),
            observedAt: NOW,
          });
          return result;
        },
      } as unknown as GitHubGraphQLClient,
      rateLimit: tracker,
      backfillWindowDays: 90,
      now,
    };

    await expect(runBackfill(db(), { workspaceId, repositoryId }, deps)).rejects.toBeInstanceOf(
      RetryableError,
    );

    const repository = (await getRepository(db(), repositoryId))!;
    expect(repository.backfillCursor).toBe('cursor-1');
    expect((await db().query('SELECT id FROM pull_requests')).rows).toHaveLength(1);
  });
});

class FakeRest {
  listCalls = 0;

  constructor(
    private readonly pages: (typeof restPullRequest extends never
      ? never
      : ReturnType<typeof restPullRequest>)[],
  ) {}

  async listPullRequestsPage(_owner: string, _repo: string, page: number) {
    this.listCalls++;
    return page === 1 ? this.pages.map((bundle) => bundle.pullRequest) : [];
  }

  async getPullRequest(_owner: string, _repo: string, number: number) {
    return this.pages.find((bundle) => bundle.pullRequest.number === number)!.pullRequest;
  }

  async listReviews(_owner: string, _repo: string, number: number) {
    return this.pages.find((bundle) => bundle.pullRequest.number === number)!.reviews;
  }

  async listCommits(_owner: string, _repo: string, number: number) {
    return this.pages.find((bundle) => bundle.pullRequest.number === number)!.commits;
  }

  async listTimeline(_owner: string, _repo: string, number: number) {
    return this.pages.find((bundle) => bundle.pullRequest.number === number)!.timeline;
  }
}

describe('incremental sync', () => {
  it('ingests pull requests updated inside the overlapping window', async () => {
    const workspace = await seedWorkspace(db());
    const repository = await seedRepository(db(), workspace.id, {
      name: 'api',
      backfillState: 'complete',
      syncedThrough: new Date(T0.getTime() - 3600_000),
    });
    const rest = new FakeRest([restPullRequest()]);

    const outcome = await runIncrementalSync(
      db(),
      { workspaceId: workspace.id, repositoryId: repository.id },
      {
        rest: rest as unknown as GitHubRestClient,
        rateLimit: openTracker(),
        overlapMinutes: 30,
        now,
      },
    );

    expect(outcome.pullRequests).toBe(1);
    const stored = (await getRepository(db(), repository.id))!;
    expect(stored.lastSuccessAt).not.toBeNull();
    expect(stored.consecutiveFailures).toBe(0);
    expect((await db().query('SELECT id FROM pull_requests')).rows).toHaveLength(1);
  });

  it('records the failure and its reason when GitHub fails', async () => {
    const workspace = await seedWorkspace(db());
    const repository = await seedRepository(db(), workspace.id, { backfillState: 'complete' });
    const rest = {
      listPullRequestsPage: async () => {
        throw new Error('502 from GitHub');
      },
    } as unknown as GitHubRestClient;

    await expect(
      runIncrementalSync(
        db(),
        { workspaceId: workspace.id, repositoryId: repository.id },
        { rest, rateLimit: openTracker(), overlapMinutes: 30, now },
      ),
    ).rejects.toThrow('502 from GitHub');

    const stored = (await getRepository(db(), repository.id))!;
    expect(stored.consecutiveFailures).toBe(1);
    expect(stored.lastError).toContain('502');
    const runs = await db().query<{ status: string; error: string }>(
      'SELECT status, error FROM sync_runs',
    );
    expect(runs.rows[0]!.status).toBe('failed');
  });

  it('schedules one sync per backfilled repository and none for those still loading', async () => {
    const workspace = await seedWorkspace(db());
    await seedRepository(db(), workspace.id, { name: 'ready', backfillState: 'complete' });
    await seedRepository(db(), workspace.id, { name: 'loading', backfillState: 'in_progress' });

    expect(await enqueueWorkspaceSyncs(db(), workspace.id)).toBe(1);
    // Running again while the first is still queued adds nothing.
    expect(await enqueueWorkspaceSyncs(db(), workspace.id)).toBe(0);
  });

  it('debounces repeated on-demand sync requests', async () => {
    const workspace = await seedWorkspace(db());
    await seedRepository(db(), workspace.id, { backfillState: 'complete' });

    const first = await requestOnDemandSync(db(), workspace.id, 120);
    expect(first).toEqual({ enqueued: 1, debounced: false });

    const second = await requestOnDemandSync(db(), workspace.id, 120);
    expect(second).toEqual({ enqueued: 0, debounced: true });
    expect(await countJobs(db(), { workspaceId: workspace.id, state: 'pending' })).toBe(1);
  });
});
