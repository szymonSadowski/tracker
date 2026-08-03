/**
 * The rollup layer: bucketing, percentiles, prorated denominators, benchmark tiers, and the
 * coverage every aggregate reports about itself (spec: metric-aggregation).
 */
import { describe, expect, it } from 'vitest';
import { databaseFixture } from '../helpers/db';
import {
  at,
  BASE_TIME,
  seedContributor,
  seedFile,
  seedPullRequest,
  seedRepository,
  seedTeam,
  seedWorkspace,
} from '../helpers/factories';
import { workspaceScope } from '../../src/db/scope';
import { analyzePullRequest } from '../../src/analysis/service';
import { churnShares, metricDistribution, metricSeries } from '../../src/analysis/series';
import { assignTier, loadBenchmarkThresholds } from '../../src/analysis/benchmarks';
import { DEFAULT_METRIC_SETTINGS } from '../../src/analysis/settings';
import { persistRepositoryCommits } from '../../src/ingest/commits';

const db = databaseFixture();

async function fixture() {
  const workspace = await seedWorkspace(db());
  const repository = await seedRepository(db(), workspace.id);
  const scope = workspaceScope(db(), workspace.id);
  return { workspaceId: workspace.id, repositoryId: repository.id, scope };
}

async function analyzeAll() {
  const { rows } = await db().query<{ id: string }>('SELECT id FROM pull_requests');
  for (const row of rows) await db().transaction((tx) => analyzePullRequest(tx, row.id));
}

describe('period bucketing', () => {
  it('returns one bucket per period, including periods with no activity', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const author = await seedContributor(db(), workspaceId, { login: 'ada' });
    await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(2),
    });
    await analyzeAll();

    const series = await metricSeries(
      scope,
      { period: { start: BASE_TIME, end: at(24 * 3), label: '3 days' }, repositoryIds: [repositoryId] },
      { granularity: 'day' },
    );

    // Four: the range starts and ends mid-day, so the first and last buckets are partial.
    expect(series).toHaveLength(4);
    expect(series[0]!.mergedCount).toBe(1);
    // An empty bucket inside coverage is present with a count of zero and absent latency.
    expect(series[1]!.mergedCount).toBe(0);
    expect(series[1]!.latency.cycle_time.p50).toBeNull();
    expect(series[1]!.outsideCoverage).toBe(false);
  });

  it('assigns a merge near midnight by the workspace time zone', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const author = await seedContributor(db(), workspaceId, { login: 'ada' });
    // 23:30 UTC on 4 May is 01:30 on 5 May in Warsaw: different days, different buckets.
    await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      openedAt: new Date('2026-05-04T20:00:00Z'),
      readyForReviewAt: new Date('2026-05-04T20:00:00Z'),
      mergedAt: new Date('2026-05-04T23:30:00Z'),
    });
    await analyzeAll();

    const range = {
      period: {
        start: new Date('2026-05-04T00:00:00Z'),
        end: new Date('2026-05-06T00:00:00Z'),
        label: 'two days',
      },
      repositoryIds: [repositoryId],
    };

    const utc = await metricSeries(scope, range, { granularity: 'day' });
    const warsaw = await metricSeries(scope, range, {
      granularity: 'day',
      settings: { ...DEFAULT_METRIC_SETTINGS, timeZone: 'Europe/Warsaw' },
    });

    expect(utc.find((bucket) => bucket.mergedCount === 1)!.start.toISOString()).toBe(
      '2026-05-04T00:00:00.000Z',
    );
    expect(warsaw.find((bucket) => bucket.mergedCount === 1)!.start.toISOString()).toBe(
      '2026-05-04T22:00:00.000Z',
    );
    // The same assignment on every run.
    expect(await metricSeries(scope, range, { granularity: 'day' })).toEqual(utc);
  });

  it('marks a bucket before the coverage start as uncovered rather than empty', async () => {
    const { repositoryId, scope } = await fixture();

    const series = await metricSeries(
      scope,
      { period: { start: BASE_TIME, end: at(48), label: 'two days' }, repositoryIds: [repositoryId] },
      { granularity: 'day', coverageStart: new Date('2026-05-02T00:00:00Z') },
    );

    expect(series[0]!.outsideCoverage).toBe(true);
    expect(series[1]!.outsideCoverage).toBe(false);
  });
});

describe('percentiles and coverage', () => {
  it('suppresses percentiles below the minimum sample size but still reports the count', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const author = await seedContributor(db(), workspaceId, { login: 'ada' });
    for (let i = 0; i < 3; i++) {
      await seedPullRequest(db(), {
        workspaceId,
        repositoryId,
        authorContributorId: author.id,
        mergedAt: at(2 + i),
      });
    }
    await analyzeAll();

    const [bucket] = await metricSeries(
      scope,
      { period: { start: BASE_TIME, end: at(24), label: 'a day' }, repositoryIds: [repositoryId] },
      { granularity: 'day' },
    );

    expect(bucket!.latency.cycle_time.contributing).toBe(3);
    expect(bucket!.latency.cycle_time.suppressed).toBe(true);
    expect(bucket!.latency.cycle_time.p75).toBeNull();
    // The mean is still stated: it is not a claim about the shape of a distribution.
    expect(bucket!.latency.cycle_time.mean).not.toBeNull();
  });

  it('reports how many pull requests contributed and how many lacked the metric', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const author = await seedContributor(db(), workspaceId, { login: 'ada' });
    const withChurn = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(2),
    });
    await seedFile(db(), {
      workspaceId,
      pullRequestId: withChurn.id,
      path: 'src/a.ts',
      additions: 40,
      changeKind: 'added',
    });
    await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(3),
    });
    await analyzeAll();

    const [bucket] = await metricSeries(
      scope,
      { period: { start: BASE_TIME, end: at(24), label: 'a day' }, repositoryIds: [repositoryId] },
      { granularity: 'day' },
    );

    expect(bucket!.churn).toMatchObject({ contributing: 1, excluded: 1, newCodeLines: 40 });
    expect(bucket!.churn!.newCodeShare).toBe(1);
  });
});

describe('the contributor denominator', () => {
  it('prorates a contributor who moves teams mid-period to 0.5 in each', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const contributor = await seedContributor(db(), workspaceId, { login: 'ada' });
    const teamA = await seedTeam(db(), workspaceId, 'A');
    const teamB = await seedTeam(db(), workspaceId, 'B');

    const monthStart = new Date('2026-05-01T00:00:00Z');
    const midMonth = new Date('2026-05-16T12:00:00Z');
    const monthEnd = new Date('2026-06-01T00:00:00Z');
    await db().query(
      `INSERT INTO team_memberships (workspace_id, team_id, contributor_id, started_at, ended_at)
       VALUES ($1,$2,$3,$4,$5), ($1,$6,$3,$5,NULL)`,
      [workspaceId, teamA.id, contributor.id, monthStart, midMonth, teamB.id],
    );

    const range = { period: { start: monthStart, end: monthEnd, label: 'May' }, repositoryIds: [repositoryId] };
    const [inA] = await metricSeries(scope, { ...range, teamId: teamA.id }, { granularity: 'month' });
    const [inB] = await metricSeries(scope, { ...range, teamId: teamB.id }, { granularity: 'month' });

    expect(inA!.contributors).toBeCloseTo(0.5, 2);
    expect(inB!.contributors).toBeCloseTo(0.5, 2);
  });

  it('leaves throughput absent when a scope has no active contributors', async () => {
    const { repositoryId, scope } = await fixture();

    const [bucket] = await metricSeries(
      scope,
      { period: { start: BASE_TIME, end: at(24), label: 'a day' }, repositoryIds: [repositoryId] },
      { granularity: 'day' },
    );

    expect(bucket!.contributors).toBe(0);
    expect(bucket!.throughputPerContributor).toBeNull();
  });

  it('divides merged pull requests by the prorated contributor count', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const team = await seedTeam(db(), workspaceId, 'Platform');
    const weekStart = new Date('2026-05-04T00:00:00Z');
    const weekEnd = new Date('2026-05-11T00:00:00Z');

    for (let i = 0; i < 5; i++) {
      const contributor = await seedContributor(db(), workspaceId, { login: `dev-${i}` });
      await db().query(
        `INSERT INTO team_memberships (workspace_id, team_id, contributor_id, started_at)
         VALUES ($1,$2,$3,$4)`,
        [workspaceId, team.id, contributor.id, new Date('2026-01-01T00:00:00Z')],
      );
      for (let j = 0; j < 4; j++) {
        await seedPullRequest(db(), {
          workspaceId,
          repositoryId,
          authorContributorId: contributor.id,
          openedAt: weekStart,
          readyForReviewAt: weekStart,
          mergedAt: new Date(weekStart.getTime() + (i + j + 1) * 3600_000),
        });
      }
    }
    await analyzeAll();

    const [bucket] = await metricSeries(
      scope,
      {
        period: { start: weekStart, end: weekEnd, label: 'a week' },
        repositoryIds: [repositoryId],
        teamId: team.id,
      },
      { granularity: 'week' },
    );

    expect(bucket!.mergedCount).toBe(20);
    expect(bucket!.contributors).toBeCloseTo(5, 2);
    expect(bucket!.throughputPerContributor).toBeCloseTo(4, 2);
  });
});

describe('commit activity', () => {
  it('counts reachable default-branch commits and excludes rewritten ones', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    await db().transaction((tx) =>
      persistRepositoryCommits(tx, {
        workspaceId,
        repositoryId,
        commits: [1, 2, 3].map((n) => ({
          oid: `sha-${n}`,
          nodeId: `C_${n}`,
          author: null,
          committedAt: at(n),
          additions: 5,
          deletions: 1,
          changedFiles: 1,
          messageHeadline: `commit ${n}`,
        })),
      }),
    );
    await db().query("UPDATE repository_commits SET reachable = false WHERE oid = 'sha-3'");

    const [bucket] = await metricSeries(
      scope,
      { period: { start: BASE_TIME, end: at(24), label: 'a day' }, repositoryIds: [repositoryId] },
      { granularity: 'day' },
    );

    expect(bucket!.commits).toBe(2);
  });
});

/**
 * `pr-metrics`: the three shares sum to the whole at the precision they are reported in. Rounding
 * each independently breaks that for any split that does not divide evenly (design.md D4).
 */
describe('churn shares', () => {
  const sum = (shares: ReturnType<typeof churnShares>) =>
    (shares.newCode ?? 0) + (shares.refactor ?? 0) + (shares.rework ?? 0);

  it('sums to exactly the whole for a split that does not divide evenly', () => {
    const shares = churnShares(100, 100, 100);

    expect(sum(shares)).toBe(1);
    for (const share of [shares.newCode, shares.refactor, shares.rework]) {
      expect(share).not.toBeNull();
      expect(share!).toBeLessThanOrEqual(1);
    }
    // No component is the residual that absorbs the drift: the extra unit lands on a remainder.
    expect([shares.newCode, shares.refactor, shares.rework].filter((s) => s === 0.334)).toHaveLength(
      1,
    );
  });

  it('sums to the whole across the awkward splits, and keeps an exact one exact', () => {
    for (const parts of [
      [1, 1, 1],
      [7, 11, 13],
      [999, 1, 0],
      [1, 0, 0],
      [2, 1, 0],
    ] as const) {
      expect(sum(churnShares(parts[0], parts[1], parts[2]))).toBe(1);
    }
    expect(churnShares(200, 0, 0)).toEqual({ newCode: 1, refactor: 0, rework: 0 });
  });

  it('leaves a bucket with no changed lines absent rather than zero', () => {
    expect(churnShares(0, 0, 0)).toEqual({ newCode: null, refactor: null, rework: null });
  });
});

describe('benchmark tiers', () => {
  it('assigns a tier from the seeded thresholds and exposes the band and its source', async () => {
    const thresholds = await loadBenchmarkThresholds(db());

    const elite = assignTier('cycle_time', 3600, thresholds);
    const needsFocus = assignTier('cycle_time', 700_000, thresholds);

    expect(elite!.tier).toBe('elite');
    expect(elite!.upperBound).toBe(90_000);
    expect(elite!.source).toContain('LinearB');
    expect(needsFocus!.tier).toBe('needs_focus');
  });

  it('assigns no tier where none is configured, and infers none', async () => {
    const thresholds = await loadBenchmarkThresholds(db());
    expect(assignTier('review_depth', 4, thresholds)).toBeNull();
  });

  it('re-evaluates a tier from an existing aggregate when the thresholds change', async () => {
    await db().query(
      "UPDATE benchmark_thresholds SET upper_bound = 1800 WHERE metric = 'cycle_time' AND tier = 'elite'",
    );
    await db().query(
      "UPDATE benchmark_thresholds SET lower_bound = 1800 WHERE metric = 'cycle_time' AND tier = 'good'",
    );

    const thresholds = await loadBenchmarkThresholds(db());

    // The same p75 that was elite before is merely good now, with no aggregate recomputed.
    expect(assignTier('cycle_time', 3600, thresholds)!.tier).toBe('good');

    await db().query(
      "UPDATE benchmark_thresholds SET upper_bound = 90000 WHERE metric = 'cycle_time' AND tier = 'elite'",
    );
    await db().query(
      "UPDATE benchmark_thresholds SET lower_bound = 90000 WHERE metric = 'cycle_time' AND tier = 'good'",
    );
  });
});

describe('distributions', () => {
  it('bins pull request size and summarises the same set', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const author = await seedContributor(db(), workspaceId, { login: 'ada' });
    for (const additions of [5, 30, 300]) {
      await seedPullRequest(db(), {
        workspaceId,
        repositoryId,
        authorContributorId: author.id,
        additions,
        deletions: 0,
        mergedAt: at(2),
      });
    }
    await analyzeAll();

    const histogram = await metricDistribution(
      scope,
      { period: { start: BASE_TIME, end: at(24), label: 'a day' }, repositoryIds: [repositoryId] },
      { metric: 'size' },
    );

    expect(histogram.summary.contributing).toBe(3);
    expect(histogram.bins.find((bin) => bin.lower === 0)!.count).toBe(1);
    expect(histogram.bins.find((bin) => bin.lower === 10)!.count).toBe(1);
    expect(histogram.bins.find((bin) => bin.lower === 250)!.count).toBe(1);
  });
});
