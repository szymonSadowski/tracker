import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { databaseFixture } from '../helpers/db.js';
import {
  at,
  seedContributor,
  seedMembership,
  seedPullRequest,
  seedRepository,
  seedReview,
  seedUser,
  seedWorkspace,
} from '../helpers/factories.js';
import { workspaceScope } from '../../src/db/scope.js';
import { analyzePullRequest } from '../../src/analysis/service.js';
import { listPullRequests, periodOfDays, teamMetrics } from '../../src/analysis/aggregate.js';
import { AccessDeniedError, allowAll, resolveWorkspaceAccess } from '../../src/auth/access.js';
import { assignContributor, createTeam } from '../../src/teams/store.js';

const db = databaseFixture();

const period = periodOfDays(90, new Date('2026-06-01T00:00:00Z'));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
  });
}

/**
 * design.md D10: there is no read path that returns contributors ordered by a throughput or
 * latency metric, and the absence of that ordering is the enforcement. This test fails if one is
 * ever introduced.
 */
describe('no cross-person ranking', () => {
  const METRIC_COLUMNS = [
    'cycle_time_seconds',
    'time_to_first_review_seconds',
    'time_to_approval_seconds',
    'time_to_merge_after_approval_seconds',
    'review_cycles',
    'post_review_pushes',
    'merged_count',
    'authored_count',
    'reviewed_count',
    'additions',
    'deletions',
  ];

  it('orders no query by a throughput or latency metric', () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles('src'), ...sourceFiles('app')]) {
      // `percentile_cont(...) WITHIN GROUP (ORDER BY x)` orders *values* inside an aggregate,
      // not people, and is exactly how a median is computed.
      const source = readFileSync(file, 'utf8').replace(
        /WITHIN GROUP \(ORDER BY[^)]*\)/g,
        'WITHIN GROUP (…)',
      );
      for (const match of source.matchAll(/ORDER BY([\s\S]{0,160})/g)) {
        const clause = match[1]!.split(/`|\n\s*\n/)[0]!;
        for (const column of METRIC_COLUMNS) {
          if (new RegExp(`\\b${column}\\b`).test(clause)) {
            offenders.push(`${file}: ORDER BY ...${column}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('exposes no per-contributor leaderboard function', async () => {
    const aggregate = await import('../../src/analysis/aggregate.js');
    const series = await import('../../src/analysis/series.js');
    const benchmarks = await import('../../src/analysis/benchmarks.js');
    const teams = await import('../../src/teams/store.js');
    const exported = [
      ...Object.keys(aggregate),
      ...Object.keys(series),
      ...Object.keys(benchmarks),
      ...Object.keys(teams),
    ];
    const suspicious = exported.filter((name) =>
      /rank|leaderboard|topContributors|byThroughput|fastest|slowest/i.test(name),
    );
    expect(suspicious).toEqual([]);
  });

  /**
   * The rollup layer is where a ranking would be cheapest to add, so the absence is asserted on
   * its shape as well as its names: no exported aggregation function takes an ordering, and
   * contributor scope names one contributor rather than accepting a set of them
   * (spec: metric-aggregation "Aggregates never rank individuals against each other").
   */
  it('accepts no contributor ordering at any scope', async () => {
    const offenders: string[] = [];
    for (const file of ['src/analysis/aggregate.ts', 'src/analysis/series.ts']) {
      const source = readFileSync(file, 'utf8');
      for (const parameter of ['orderBy', 'sortBy', 'sortDirection', 'contributorIds']) {
        if (new RegExp(`\\b${parameter}\\b`).test(source)) offenders.push(`${file}: ${parameter}`);
      }
    }
    expect(offenders).toEqual([]);

    const series = await import('../../src/analysis/series.js');
    // Every exported entry point takes the scope filter, which names at most one contributor.
    expect(Object.keys(series)).toContain('metricSeries');
  });

  it('sorts a metric list by time, not by how a person performed', async () => {
    const workspace = await seedWorkspace(db());
    const repository = await seedRepository(db(), workspace.id);
    const slow = await seedContributor(db(), workspace.id, { login: 'slow' });
    const quick = await seedContributor(db(), workspace.id, { login: 'quick' });
    await seedPullRequest(db(), {
      workspaceId: workspace.id,
      repositoryId: repository.id,
      authorContributorId: slow.id,
      mergedAt: at(48),
      title: 'slow one',
    });
    await seedPullRequest(db(), {
      workspaceId: workspace.id,
      repositoryId: repository.id,
      authorContributorId: quick.id,
      mergedAt: at(1),
      title: 'quick one',
    });
    const prs = await db().query<{ id: string }>('SELECT id FROM pull_requests');
    for (const row of prs.rows) await db().transaction((tx) => analyzePullRequest(tx, row.id));

    const list = await listPullRequests(workspaceScope(db(), workspace.id), {
      period,
      repositoryIds: [repository.id],
    });

    // Most recently merged first — not fastest first.
    expect(list.map((item) => item.title)).toEqual(['slow one', 'quick one']);
  });
});

/**
 * design.md D7: the personal view's only comparison is against the viewer's own previous period,
 * so it withholds benchmark tiers and thresholds while showing every neutral affordance the team
 * view shows. The two views now differ in a way that reads as an oversight, and the instinct of the
 * next person to read them side by side is to make them match — this is what fails when they do.
 */
describe('no industry norm on a personal surface', () => {
  const PERSONAL_PAGES = [
    'app/w/[workspaceId]/me/page.tsx',
    'app/w/[workspaceId]/people/[contributorId]/page.tsx',
  ];

  it('passes no benchmark assignment or threshold into a chart', () => {
    const offenders: string[] = [];
    for (const file of PERSONAL_PAGES) {
      const source = readFileSync(file, 'utf8');
      // The props a chart takes to render a tier, a band, or a threshold rule.
      for (const prop of ['benchmark', 'benchmarks', 'reworkThreshold', 'refactorThreshold']) {
        if (new RegExp(`\\b${prop}=\\{`).test(source)) offenders.push(`${file}: ${prop}=`);
      }
      if (/BenchmarkTier/.test(source)) offenders.push(`${file}: BenchmarkTier`);
    }
    expect(offenders).toEqual([]);
  });

  it('still shows the neutral affordances the team view shows', () => {
    const source = readFileSync('app/w/[workspaceId]/me/page.tsx', 'utf8');

    // Drill-through, the churn coverage statement, and the shares/lines toggle are facts about the
    // data, not judgments about the person, so withholding them is a loss and not a protection.
    expect(source).toMatch(/drillThrough=\{/);
    expect(source).toMatch(/coveredFrom=\{/);
    expect(source).toMatch(/toggleHref=\{/);
  });
});

describe('drill-through and detail access', () => {
  async function scenario() {
    const workspace = await seedWorkspace(db());
    const repository = await seedRepository(db(), workspace.id);
    const scope = workspaceScope(db(), workspace.id);
    const ada = await seedContributor(db(), workspace.id, { login: 'ada' });
    const bob = await seedContributor(db(), workspace.id, { login: 'bob' });
    const team = await createTeam(scope, 'Platform');
    await assignContributor(scope, ada.id, team.id);

    for (const [index, contributor] of [ada, ada, bob].entries()) {
      const pr = await seedPullRequest(db(), {
        workspaceId: workspace.id,
        repositoryId: repository.id,
        authorContributorId: contributor.id,
        mergedAt: at(4 + index),
      });
      if (index === 0) {
        await seedReview(db(), {
          workspaceId: workspace.id,
          pullRequestId: pr.id,
          reviewerContributorId: bob.id,
          submittedAt: at(1),
        });
      }
    }
    const prs = await db().query<{ id: string }>('SELECT id FROM pull_requests');
    for (const row of prs.rows) await db().transaction((tx) => analyzePullRequest(tx, row.id));

    return { workspace, repository, scope, team, ada, bob };
  }

  it('returns exactly the pull requests a team metric was computed from', async () => {
    const { repository, scope, team } = await scenario();
    const filter = { period, repositoryIds: [repository.id], teamId: team.id };

    const metrics = await teamMetrics(scope, filter);
    const list = await listPullRequests(scope, filter);

    expect(metrics.mergedCount).toBe(2);
    expect(list).toHaveLength(metrics.mergedCount);
    expect(new Set(list.map((item) => item.authorLogin))).toEqual(new Set(['ada']));
  });

  it('rejects a non-owner managing teams, whether or not the interface offered it', async () => {
    const { workspace } = await scenario();
    const member = await seedUser(db(), { login: 'member' });
    await seedMembership(db(), workspace.id, member.id, 'member');

    // The same call the server action makes before touching any team data.
    await expect(
      resolveWorkspaceAccess(db(), {
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
        requireOwner: true,
      }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });
});
