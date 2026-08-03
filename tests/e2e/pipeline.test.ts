/**
 * End-to-end: install against a fixture organization, backfill, analyze, and produce exactly what
 * the team view renders. Everything but GitHub itself is real — the queue, the worker, the
 * normalizer, the metric definitions, and the aggregate queries.
 */
import { describe, expect, it } from 'vitest';
import { databaseFixture } from '../helpers/db.js';
import { graphqlPullRequest, iso } from '../helpers/github-fixtures.js';
import {
  ingestInstallation,
  type InstallationGateway,
} from '../../src/installations/github-sync.js';
import type { GitHubInstallationDetails } from '../../src/installations/github-sync.js';
import type { RestRepository } from '../../src/github/rest.js';
import type { GitHubGraphQLClient, PullRequestPage } from '../../src/github/graphql.js';
import { seedUser } from '../helpers/factories.js';
import { Worker } from '../../src/jobs/worker.js';
import { runBackfill } from '../../src/ingest/backfill.js';
import { analyzePullRequest } from '../../src/analysis/service.js';
import { enqueueWorkspaceSyncs, requestOnDemandSync } from '../../src/ingest/incremental.js';
import { requestHistorySync, runHistorySync } from '../../src/ingest/history.js';
import { RateLimitTracker } from '../../src/github/rate-limit.js';
import { workspaceScope } from '../../src/db/scope.js';
import { listRepositories, syncStatus } from '../../src/repositories/store.js';
import { assignContributor, createTeam, listRoster } from '../../src/teams/store.js';
import { periodOfDays, teamMetrics, listPullRequests } from '../../src/analysis/aggregate.js';
import { allowAll, resolveWorkspaceAccess } from '../../src/auth/access.js';
import { formatDuration } from '../../src/ui/format.js';
import { countJobs } from '../../src/jobs/queue.js';

const db = databaseFixture();

const NOW = new Date('2026-04-15T09:00:00.000Z');

const repository = (name: string): RestRepository => ({
  id: 1,
  node_id: `R_${name}`,
  name,
  full_name: `fixture-org/${name}`,
  private: true,
  default_branch: 'main',
  owner: { login: 'fixture-org', id: 9, node_id: 'O_fixture', type: 'Organization' },
});

class FixtureGateway implements InstallationGateway {
  async getInstallation(): Promise<GitHubInstallationDetails> {
    return {
      id: 999,
      account: { node_id: 'O_fixture', login: 'fixture-org', type: 'Organization' },
      repository_selection: 'selected',
    };
  }

  async listRepositories(): Promise<RestRepository[]> {
    return [repository('api'), repository('web')];
  }
}

/** Two repositories' worth of pull requests, one of them authored by a bot. */
function pageFor(repositoryName: string): PullRequestPage {
  const nodes = [
    graphqlPullRequest({ nodeId: `PR_${repositoryName}_1`, number: 1, mergedAtHours: 8 }),
    graphqlPullRequest({ nodeId: `PR_${repositoryName}_2`, number: 2, mergedAtHours: 4 }),
    graphqlPullRequest({
      nodeId: `PR_${repositoryName}_bot`,
      number: 3,
      mergedAtHours: 1,
      authorIsBot: true,
    }),
  ];
  return { nodes, endCursor: null, hasNextPage: false, rateLimit: undefined };
}

describe('install → backfill → analyze → team view', () => {
  it('produces the numbers the team surface renders', async () => {
    const installer = await seedUser(db(), { login: 'ada' });

    // 1. Install the App against the fixture organization.
    const installed = await ingestInstallation(db(), new FixtureGateway(), 999, installer.id);
    expect(installed.workspaceCreated).toBe(true);
    expect(
      await countJobs(db(), { workspaceId: installed.workspaceId, type: 'repository.backfill' }),
    ).toBe(2);

    // 2. Drain the queue with a worker. Backfill is fed a fixture GraphQL client; analysis runs
    //    for real, from the rows the normalizer wrote.
    const worker = new Worker(db(), {
      'repository.backfill': async (ctx) => {
        const repositories = await listRepositories(ctx.db, ctx.workspaceId);
        const target = repositories.find((r) => r.id === ctx.payload.repositoryId)!;
        await runBackfill(
          ctx.db,
          { workspaceId: ctx.workspaceId, repositoryId: target.id },
          {
            graphql: {
              fetchPullRequestPage: async () => pageFor(target.name),
            } as unknown as GitHubGraphQLClient,
            rateLimit: new RateLimitTracker(100),
            backfillWindowDays: 90,
            now: () => NOW,
          },
        );
      },
      'pull_request.analyze': async (ctx) => {
        await ctx.db.transaction((tx) => analyzePullRequest(tx, ctx.payload.pullRequestId));
      },
    });
    const outcomes = await worker.drain();
    expect(outcomes.every((outcome) => outcome.result === 'succeeded')).toBe(true);

    // 3. Both repositories are backfilled, and every pull request has an analysis record.
    const repositories = await listRepositories(db(), installed.workspaceId, { inScopeOnly: true });
    expect(repositories.map((r) => r.backfillState)).toEqual(['complete', 'complete']);
    const analysisRows = await db().query('SELECT pull_request_id FROM pr_analysis');
    expect(analysisRows.rows).toHaveLength(6);

    const status = await syncStatus(db(), installed.workspaceId);
    expect(status.backfilling).toEqual([]);
    expect(status.lastSuccessAt).not.toBeNull();

    // 4. Group the discovered contributors into a team.
    const scope = workspaceScope(db(), installed.workspaceId);
    const roster = await listRoster(scope);
    expect(roster.map((entry) => entry.login)).toEqual(['ada', 'bob']);
    const team = await createTeam(scope, 'Platform');
    for (const entry of roster) await assignContributor(scope, entry.contributorId, team.id);

    // 5. Read the surface exactly as the page does: visible repositories, then aggregates.
    const access = await resolveWorkspaceAccess(db(), {
      workspaceId: installed.workspaceId,
      user: {
        id: installer.id,
        githubUserId: installer.githubUserId,
        githubNodeId: installer.githubNodeId,
        login: installer.login,
        name: null,
        avatarUrl: null,
      },
      checker: allowAll,
      permissionCacheSeconds: 300,
    });
    expect(access.role).toBe('owner');

    const filter = {
      period: periodOfDays(30, NOW),
      repositoryIds: access.visibleRepositoryIds,
      teamId: team.id,
    };
    const metrics = await teamMetrics(scope, filter);
    const drillThrough = await listPullRequests(scope, filter);

    // Four human pull requests (two per repository); the two bot ones are excluded by default.
    expect(metrics.mergedCount).toBe(4);
    expect(drillThrough).toHaveLength(metrics.mergedCount);
    // Cycle time is anchored at the first commit, an hour before the pull request opens
    // (design.md D1), so it covers an hour more than the ready-for-review anchor would:
    // 7h and 3h across four pull requests → a 5h median.
    expect(formatDuration(metrics.cycleTime.median)).toBe('5h');
    expect(metrics.cycleTime.covered).toBe(4);
    // First review at +4h, ready at +2h.
    expect(formatDuration(metrics.timeToFirstReview.median)).toBe('2h');
    expect(metrics.sizeDistribution.m).toBe(4);
    expect(iso(8)).toContain('2026-04-01');

    // 6. Periodic sync takes over now that backfill is complete.
    expect(await enqueueWorkspaceSyncs(db(), installed.workspaceId)).toBe(2);
  });

  /**
   * The two controls the settings page exposes, driven through the same calls their routes make:
   * the history request extends coverage backwards, and a second sync-now inside the debounce
   * interval reports itself rather than disappearing (spec: github-data-sync).
   */
  it('extends coverage on request and reports a debounced sync back to the member', async () => {
    const installer = await seedUser(db(), { login: 'ada' });
    const installed = await ingestInstallation(db(), new FixtureGateway(), 999, installer.id);

    const backfiller = new Worker(db(), {
      'repository.backfill': async (ctx) => {
        const repositories = await listRepositories(ctx.db, ctx.workspaceId);
        const target = repositories.find((r) => r.id === ctx.payload.repositoryId)!;
        await runBackfill(
          ctx.db,
          { workspaceId: ctx.workspaceId, repositoryId: target.id },
          {
            graphql: {
              fetchPullRequestPage: async () => pageFor(target.name),
            } as unknown as GitHubGraphQLClient,
            rateLimit: new RateLimitTracker(100),
            backfillWindowDays: 90,
            now: () => NOW,
          },
        );
      },
      'pull_request.analyze': async () => {},
    });
    await backfiller.drain();

    // Coverage after the default backfill reaches back exactly one window, no further.
    const windowStart = new Date(NOW.getTime() - 90 * 24 * 3600_000);
    const afterBackfill = await syncStatus(db(), installed.workspaceId);
    expect(afterBackfill.coverageStart).toEqual(windowStart);

    // A member asks for everything. One job per repository, none of it done yet.
    const requested = await requestHistorySync(db(), installed.workspaceId, null);
    expect(requested.enqueued).toBe(2);
    expect(requested.repositories.map((r) => r.status)).toEqual(['enqueued', 'enqueued']);

    // The walk finds one pull request created well before the backfill window.
    const ancient = graphqlPullRequest({
      nodeId: 'PR_ancient',
      number: 99,
      createdAtHours: -24 * 400,
      mergedAtHours: 8,
    });
    const historian = new Worker(db(), {
      'repository.history_sync': async (ctx) => {
        await runHistorySync(
          ctx.db,
          {
            workspaceId: ctx.workspaceId,
            repositoryId: ctx.payload.repositoryId,
            from: ctx.payload.from ? new Date(ctx.payload.from) : null,
          },
          {
            graphql: {
              fetchPullRequestPageByCreation: async () => ({
                nodes: [ancient],
                endCursor: null,
                hasNextPage: false,
                rateLimit: undefined,
              }),
            } as unknown as GitHubGraphQLClient,
            rateLimit: new RateLimitTracker(100),
            now: () => NOW,
          },
        );
      },
      'pull_request.analyze': async () => {},
    });
    const historyOutcomes = await historian.drain();
    expect(historyOutcomes.every((outcome) => outcome.result === 'succeeded')).toBe(true);

    // Coverage now reaches the repository's first pull request, so nothing bounds it.
    const afterHistory = await syncStatus(db(), installed.workspaceId);
    expect(afterHistory.coverageStart).toBeNull();
    expect(afterHistory.coverage.every((entry) => entry.historyComplete)).toBe(true);
    expect(afterHistory.historySyncing).toEqual([]);

    // Asking again is answered, not repeated: everything is already covered.
    const again = await requestHistorySync(db(), installed.workspaceId, null);
    expect(again.enqueued).toBe(0);
    expect(again.repositories.map((r) => r.status)).toEqual(['already_covered', 'already_covered']);

    // Sync now, twice: the second is inside the debounce interval and says so.
    const first = await requestOnDemandSync(db(), installed.workspaceId, 120);
    expect(first).toMatchObject({ enqueued: 2, debounced: false, backfilling: [] });
    const second = await requestOnDemandSync(db(), installed.workspaceId, 120);
    expect(second).toMatchObject({ enqueued: 0, debounced: true });
  });

  it('keeps a large backfill resumable and inside its rate limit budget', async () => {
    const installer = await seedUser(db(), { login: 'ada' });
    const installed = await ingestInstallation(db(), new FixtureGateway(), 999, installer.id);
    const target = (await listRepositories(db(), installed.workspaceId))[0]!;

    // 40 pages of 25 pull requests: more than one run's page budget, several times over.
    const PAGES = 40;
    const PER_PAGE = 25;
    let requests = 0;
    const tracker = new RateLimitTracker(200);
    let remaining = 5000;

    const graphql = {
      fetchPullRequestPage: async (input: { after?: string | null }) => {
        requests++;
        const index = input.after ? Number(input.after.replace('cursor-', '')) : 0;
        remaining -= 10;
        tracker.observe({
          limit: 5000,
          remaining,
          resetAt: new Date(NOW.getTime() + 3600_000),
          observedAt: NOW,
        });
        return {
          nodes: Array.from({ length: PER_PAGE }, (_, i) =>
            graphqlPullRequest({
              nodeId: `PR_${index}_${i}`,
              number: index * PER_PAGE + i,
              mergedAtHours: 4,
            }),
          ),
          endCursor: `cursor-${index + 1}`,
          hasNextPage: index + 1 < PAGES,
          rateLimit: undefined,
        } as PullRequestPage;
      },
    } as unknown as GitHubGraphQLClient;

    // Each run does a bounded slice; the job re-enqueues itself until the window is covered.
    let runs = 0;
    for (;;) {
      const outcome = await runBackfill(
        db(),
        { workspaceId: installed.workspaceId, repositoryId: target.id },
        { graphql, rateLimit: tracker, backfillWindowDays: 90, now: () => NOW },
      );
      runs++;
      if (outcome.complete) break;
      expect(runs).toBeLessThan(20);
    }

    const stored = await db().query<{ count: number }>(
      'SELECT count(*)::int AS count FROM pull_requests WHERE repository_id = $1',
      [target.id],
    );
    expect(stored.rows[0]!.count).toBe(PAGES * PER_PAGE);
    expect(requests).toBe(PAGES);
    expect(runs).toBe(PAGES / 5);
    // Progress was recorded page by page, so any of those runs could have been the last one.
    const runsRecorded = await db().query<{ count: number }>(
      "SELECT count(*)::int AS count FROM sync_runs WHERE status = 'paused'",
    );
    expect(runsRecorded.rows[0]!.count).toBe(runs - 1);
  }, 120_000);
});
