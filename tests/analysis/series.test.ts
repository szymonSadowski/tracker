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
import {
  churnShares,
  contributorThroughputSeries,
  mergeEventSeries,
  metricDistribution,
  metricSeries,
} from '../../src/analysis/series';
import { teamMetrics } from '../../src/analysis/aggregate';
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
      {
        period: { start: BASE_TIME, end: at(24 * 3), label: '3 days' },
        repositoryIds: [repositoryId],
      },
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
      {
        period: { start: BASE_TIME, end: at(48), label: 'two days' },
        repositoryIds: [repositoryId],
      },
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

    const range = {
      period: { start: monthStart, end: monthEnd, label: 'May' },
      repositoryIds: [repositoryId],
    };
    const [inA] = await metricSeries(
      scope,
      { ...range, teamId: teamA.id },
      { granularity: 'month' },
    );
    const [inB] = await metricSeries(
      scope,
      { ...range, teamId: teamB.id },
      { granularity: 'month' },
    );

    expect(inA!.contributors).toBeCloseTo(0.5, 2);
    expect(inB!.contributors).toBeCloseTo(0.5, 2);
  });

  it('leaves throughput absent when a scope has no active contributors and nothing merged', async () => {
    const { repositoryId, scope } = await fixture();

    const [bucket] = await metricSeries(
      scope,
      { period: { start: BASE_TIME, end: at(24), label: 'a day' }, repositoryIds: [repositoryId] },
      { granularity: 'day' },
    );

    expect(bucket!.contributors).toBe(0);
    // Nothing merged and nobody in scope: there is no rate to state, and no count being withheld.
    expect(bucket!.mergedCount).toBe(0);
    expect(bucket!.throughputPerContributor).toBeNull();
    expect(bucket!.denominatorMissing).toBe(false);
  });

  it('reports the merged count when merges exist and the denominator is empty', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    // No membership row, which is the shape the reporting workspace was in: memberships begin at
    // first sync while ingested pull requests reach further back. The bucket used to go absent and
    // the merges were drawn nowhere at all.
    const ada = await seedContributor(db(), workspaceId, { login: 'ada' });
    for (const hours of [1, 2, 3]) {
      await seedPullRequest(db(), {
        workspaceId,
        repositoryId,
        authorContributorId: ada.id,
        mergedAt: at(hours),
      });
    }
    await analyzeAll();

    const [bucket] = await metricSeries(
      scope,
      { period: { start: BASE_TIME, end: at(24), label: 'a day' }, repositoryIds: [repositoryId] },
      { granularity: 'day' },
    );

    expect(bucket!.contributors).toBe(0);
    expect(bucket!.mergedCount).toBe(3);
    // The count wins over the empty denominator, and says that is what it is.
    expect(bucket!.throughputPerContributor).toBe(3);
    expect(bucket!.throughputPerContributorDay).toBe(3);
    expect(bucket!.denominatorMissing).toBe(true);
  });

  it('sums a contributor-scoped period to the merged count the tile reports', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const ada = await seedContributor(db(), workspaceId, { login: 'ada' });
    // Membership begins on the third day of a four-day window: every earlier bucket has a zero
    // denominator, which is exactly where merges used to disappear.
    await db().query(
      `INSERT INTO workspace_memberships (workspace_id, contributor_id, started_at)
       VALUES ($1, $2, $3)`,
      [workspaceId, ada.id, at(24 * 2)],
    );
    for (const hours of [1, 25, 49, 73]) {
      await seedPullRequest(db(), {
        workspaceId,
        repositoryId,
        authorContributorId: ada.id,
        mergedAt: at(hours),
      });
    }
    await analyzeAll();

    const filter = {
      period: { start: BASE_TIME, end: at(24 * 4), label: '4 days' },
      repositoryIds: [repositoryId],
      contributorId: ada.id,
    };
    const buckets = await metricSeries(scope, filter, { granularity: 'day' });
    const tile = await teamMetrics(scope, filter);

    expect(tile.mergedCount).toBe(4);
    expect(buckets.reduce((sum, bucket) => sum + bucket.mergedCount, 0)).toBe(tile.mergedCount);
    // No bucket holding a merge is absent, whatever the membership intervals say.
    for (const bucket of buckets) {
      if (bucket.mergedCount > 0) expect(bucket.throughputPerContributor).not.toBeNull();
    }
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
    expect(
      [shares.newCode, shares.refactor, shares.rework].filter((s) => s === 0.334),
    ).toHaveLength(1);
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

describe('per-author throughput', () => {
  it('returns one series per author, ordered by name and never by output', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    // Seeded so the busiest author sorts last alphabetically: if the ordering ever became
    // "most merged first", zoe would lead and this assertion would catch it.
    const ada = await seedContributor(db(), workspaceId, { login: 'ada' });
    const zoe = await seedContributor(db(), workspaceId, { login: 'zoe' });
    await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: ada.id,
      mergedAt: at(2),
    });
    for (const hours of [3, 4, 5]) {
      await seedPullRequest(db(), {
        workspaceId,
        repositoryId,
        authorContributorId: zoe.id,
        mergedAt: at(hours),
      });
    }
    await analyzeAll();

    const result = await contributorThroughputSeries(
      scope,
      {
        period: { start: BASE_TIME, end: at(24), label: 'day' },
        repositoryIds: [repositoryId],
      },
      { granularity: 'day' },
    );

    expect(result.contributors.map((entry) => entry.login)).toEqual(['ada', 'zoe']);
    const totals = new Map(
      result.contributors.map((entry) => [
        entry.login,
        entry.points.reduce<number>((sum, point) => sum + (point ?? 0), 0),
      ]),
    );
    expect(totals.get('ada')).toBe(1);
    expect(totals.get('zoe')).toBe(3);
    // Every series is aligned to the same bucket list, so index n means the same bucket for all.
    for (const entry of result.contributors) {
      expect(entry.points).toHaveLength(result.buckets.length);
    }
  });

  it('counts a bucket the author merged nothing in as zero, not as a gap', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const ada = await seedContributor(db(), workspaceId, { login: 'ada' });
    await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: ada.id,
      mergedAt: at(2),
    });
    await analyzeAll();

    const result = await contributorThroughputSeries(
      scope,
      {
        period: { start: BASE_TIME, end: at(24 * 3), label: '3 days' },
        repositoryIds: [repositoryId],
      },
      { granularity: 'day' },
    );

    const ada_ = result.contributors.find((entry) => entry.login === 'ada')!;
    expect(ada_.points[0]).toBe(1);
    // A quiet day is a measured zero. Drawing it as a gap would hide inactivity.
    expect(ada_.points[1]).toBe(0);
  });

  it('omits an author with no merged pull request in the period', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const ada = await seedContributor(db(), workspaceId, { login: 'ada' });
    await seedContributor(db(), workspaceId, { login: 'idle' });
    await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: ada.id,
      mergedAt: at(2),
    });
    await analyzeAll();

    const result = await contributorThroughputSeries(
      scope,
      { period: { start: BASE_TIME, end: at(24), label: 'day' }, repositoryIds: [repositoryId] },
      { granularity: 'day' },
    );

    expect(result.contributors.map((entry) => entry.login)).toEqual(['ada']);
  });
});

describe('per-author throughput and tenure', () => {
  it('draws a bucket before the author joined as a gap, not a zero', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const ada = await seedContributor(db(), workspaceId, { login: 'ada' });
    // Joined on the third day of a four-day window, then merged once.
    await db().query(
      `INSERT INTO workspace_memberships (workspace_id, contributor_id, started_at)
       VALUES ($1, $2, $3)`,
      [workspaceId, ada.id, at(24 * 2)],
    );
    await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: ada.id,
      mergedAt: at(24 * 2 + 3),
    });
    await analyzeAll();

    const result = await contributorThroughputSeries(
      scope,
      {
        period: { start: BASE_TIME, end: at(24 * 4), label: '4 days' },
        repositoryIds: [repositoryId],
      },
      { granularity: 'day' },
    );

    const series = result.contributors.find((entry) => entry.login === 'ada')!;
    // Buckets wholly before the join are gaps; the bucket they joined in is a real measurement.
    expect(series.points[0]).toBeNull();
    expect(series.points[1]).toBeNull();
    expect(series.points[2]).toBe(1);
  });

  it('leaves a contributor with no membership row unmasked', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    // seedContributor writes no membership row, which is the shape of a contributor whose tenure
    // is unknown. Masking on unknown would blank the whole line.
    const ada = await seedContributor(db(), workspaceId, { login: 'ada' });
    await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: ada.id,
      mergedAt: at(2),
    });
    await analyzeAll();

    const result = await contributorThroughputSeries(
      scope,
      { period: { start: BASE_TIME, end: at(24), label: 'day' }, repositoryIds: [repositoryId] },
      { granularity: 'day' },
    );

    const series = result.contributors.find((entry) => entry.login === 'ada')!;
    expect(series.points.every((point) => point !== null)).toBe(true);
  });
});

describe('merged pull requests as events', () => {
  it('returns one event per merged pull request, matching the bucketed count', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const ada = await seedContributor(db(), workspaceId, { login: 'ada' });
    for (const hours of [1, 5, 30, 54]) {
      await seedPullRequest(db(), {
        workspaceId,
        repositoryId,
        authorContributorId: ada.id,
        mergedAt: at(hours),
      });
    }
    await analyzeAll();

    const filter = {
      period: { start: BASE_TIME, end: at(24 * 3), label: '3 days' },
      repositoryIds: [repositoryId],
    };
    const events = await mergeEventSeries(scope, filter);
    const buckets = await metricSeries(scope, filter, { granularity: 'day' });

    // The two resolutions of one metric: whatever the bucketing, the same merges.
    const total = events.contributors.reduce((sum, group) => sum + group.events.length, 0);
    expect(total).toBe(buckets.reduce((sum, bucket) => sum + bucket.mergedCount, 0));
    expect(total).toBe(4);
  });

  it('orders groups by name and never by how many events each has', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    // zoe sorts last alphabetically and first by output: if the ordering ever became a ranking,
    // this assertion is what catches it.
    const ada = await seedContributor(db(), workspaceId, { login: 'ada' });
    const zoe = await seedContributor(db(), workspaceId, { login: 'zoe' });
    await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: ada.id,
      mergedAt: at(2),
    });
    for (const hours of [3, 4, 5]) {
      await seedPullRequest(db(), {
        workspaceId,
        repositoryId,
        authorContributorId: zoe.id,
        mergedAt: at(hours),
      });
    }
    await analyzeAll();

    const result = await mergeEventSeries(scope, {
      period: { start: BASE_TIME, end: at(24), label: 'day' },
      repositoryIds: [repositoryId],
    });

    expect(result.contributors.map((group) => group.login)).toEqual(['ada', 'zoe']);
    expect(result.contributors.map((group) => group.events.length)).toEqual([1, 3]);
    expect(result.truncated).toBe(false);
  });

  it('omits a contributor with no merged pull request in the period', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const ada = await seedContributor(db(), workspaceId, { login: 'ada' });
    await seedContributor(db(), workspaceId, { login: 'idle' });
    await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: ada.id,
      mergedAt: at(2),
    });
    await analyzeAll();

    const result = await mergeEventSeries(scope, {
      period: { start: BASE_TIME, end: at(24), label: 'day' },
      repositoryIds: [repositoryId],
    });

    // Absent, not present with an empty group: a flat line per non-merging member says more about
    // who is being watched than about the work.
    expect(result.contributors.map((group) => group.login)).toEqual(['ada']);
  });

  it('orders events by merge time and names the pull request behind each', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const ada = await seedContributor(db(), workspaceId, { login: 'ada' });
    // Seeded out of order, so the ordering is the query's rather than the insertion's.
    for (const hours of [7, 2, 5]) {
      await seedPullRequest(db(), {
        workspaceId,
        repositoryId,
        authorContributorId: ada.id,
        title: `Change at ${hours}h`,
        mergedAt: at(hours),
      });
    }
    await analyzeAll();

    const result = await mergeEventSeries(scope, {
      period: { start: BASE_TIME, end: at(24), label: 'day' },
      repositoryIds: [repositoryId],
    });

    const events = result.contributors[0]!.events;
    expect(events.map((event) => event.title)).toEqual([
      'Change at 2h',
      'Change at 5h',
      'Change at 7h',
    ]);
    const times = events.map((event) => event.mergedAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // Enough identity to name a step and to link out of the chart to it.
    for (const event of events) {
      expect(event.number).toBeGreaterThan(0);
      expect(event.url).toContain('/pull/');
      expect(event.repositoryFullName).toBeTruthy();
    }
  });

  it('says so when the per-contributor cap trims a group', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const ada = await seedContributor(db(), workspaceId, { login: 'ada' });
    for (const hours of [1, 2, 3]) {
      await seedPullRequest(db(), {
        workspaceId,
        repositoryId,
        authorContributorId: ada.id,
        mergedAt: at(hours),
      });
    }
    await analyzeAll();

    const result = await mergeEventSeries(
      scope,
      { period: { start: BASE_TIME, end: at(24), label: 'day' }, repositoryIds: [repositoryId] },
      { limit: 2 },
    );

    // A short series that said nothing would disagree with the headline count in silence.
    expect(result.contributors[0]!.events).toHaveLength(2);
    expect(result.contributors[0]!.truncated).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('limits results to the requested contributors', async () => {
    const { workspaceId, repositoryId, scope } = await fixture();
    const ada = await seedContributor(db(), workspaceId, { login: 'ada' });
    const zoe = await seedContributor(db(), workspaceId, { login: 'zoe' });
    await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: ada.id,
      mergedAt: at(2),
    });
    await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: zoe.id,
      mergedAt: at(3),
    });
    await analyzeAll();

    const result = await mergeEventSeries(
      scope,
      { period: { start: BASE_TIME, end: at(24), label: 'day' }, repositoryIds: [repositoryId] },
      { contributorIds: [ada.id] },
    );

    expect(result.contributors.map((group) => group.login)).toEqual(['ada']);
    expect(result.truncated).toBe(false);
  });
});
