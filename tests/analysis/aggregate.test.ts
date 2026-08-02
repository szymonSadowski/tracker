import { describe, expect, it } from 'vitest';
import { databaseFixture } from '../helpers/db';
import {
  at,
  BASE_TIME,
  hours,
  seedContributor,
  seedPullRequest,
  seedRepository,
  seedReview,
  seedWorkspace,
} from '../helpers/factories';
import { analyzePullRequest } from '../../src/analysis/service';
import { listPullRequests, teamMetrics, type MetricScope } from '../../src/analysis/aggregate';
import { workspaceScope } from '../../src/db/scope';

const db = databaseFixture();

const period = {
  start: new Date('2026-04-01T00:00:00Z'),
  end: new Date('2026-06-01T00:00:00Z'),
  label: '',
};

async function fixture() {
  const workspace = await seedWorkspace(db());
  const repository = await seedRepository(db(), workspace.id);
  const author = await seedContributor(db(), workspace.id, { login: 'ada' });
  const reviewer = await seedContributor(db(), workspace.id, { login: 'bob' });
  const bot = await seedContributor(db(), workspace.id, { login: 'renovate', isBot: true });
  return { workspace, repository, author, reviewer, bot };
}

async function analyzeAll() {
  const { rows } = await db().query<{ id: string }>('SELECT id FROM pull_requests');
  for (const row of rows) await db().transaction((tx) => analyzePullRequest(tx, row.id));
}

describe('aggregates', () => {
  it('reports medians over the values that exist and how many they cover', async () => {
    const { workspace, repository, author, reviewer } = await fixture();

    // Three merged pull requests; only two were reviewed.
    for (const [index, mergeHours] of [2, 6, 10].entries()) {
      const pr = await seedPullRequest(db(), {
        workspaceId: workspace.id,
        repositoryId: repository.id,
        authorContributorId: author.id,
        openedAt: BASE_TIME,
        readyForReviewAt: BASE_TIME,
        mergedAt: at(mergeHours),
      });
      if (index < 2) {
        await seedReview(db(), {
          workspaceId: workspace.id,
          pullRequestId: pr.id,
          reviewerContributorId: reviewer.id,
          submittedAt: at(1),
        });
      }
    }
    await analyzeAll();

    const scope: MetricScope = { period, repositoryIds: [repository.id] };
    const metrics = await teamMetrics(workspaceScope(db(), workspace.id), scope);

    expect(metrics.mergedCount).toBe(3);
    expect(metrics.cycleTime.median).toBe(hours(6));
    expect(metrics.cycleTime.covered).toBe(3);
    // The unreviewed pull request contributes no value and is not counted as zero.
    expect(metrics.timeToFirstReview.median).toBe(hours(1));
    expect(metrics.timeToFirstReview.covered).toBe(2);
    expect(metrics.timeToFirstReview.total).toBe(3);
  });

  it('excludes bot-authored pull requests by default', async () => {
    const { workspace, repository, author, bot } = await fixture();
    await seedPullRequest(db(), {
      workspaceId: workspace.id,
      repositoryId: repository.id,
      authorContributorId: author.id,
      mergedAt: at(4),
    });
    for (let i = 0; i < 5; i++) {
      await seedPullRequest(db(), {
        workspaceId: workspace.id,
        repositoryId: repository.id,
        authorContributorId: bot.id,
        mergedAt: at(1),
      });
    }
    await analyzeAll();

    const scope = workspaceScope(db(), workspace.id);
    expect((await teamMetrics(scope, { period, repositoryIds: [repository.id] })).mergedCount).toBe(
      1,
    );
    expect(
      (await teamMetrics(scope, { period, repositoryIds: [repository.id], includeBots: true }))
        .mergedCount,
    ).toBe(6);
  });

  it('returns exactly the pull requests an aggregate was computed from', async () => {
    const { workspace, repository, author, bot } = await fixture();
    await seedPullRequest(db(), {
      workspaceId: workspace.id,
      repositoryId: repository.id,
      authorContributorId: author.id,
      mergedAt: at(4),
      title: 'counted',
    });
    await seedPullRequest(db(), {
      workspaceId: workspace.id,
      repositoryId: repository.id,
      authorContributorId: bot.id,
      mergedAt: at(4),
      title: 'bot noise',
    });
    // Outside the period.
    await seedPullRequest(db(), {
      workspaceId: workspace.id,
      repositoryId: repository.id,
      authorContributorId: author.id,
      openedAt: new Date('2026-01-01T00:00:00Z'),
      readyForReviewAt: new Date('2026-01-01T00:00:00Z'),
      mergedAt: new Date('2026-01-02T00:00:00Z'),
      title: 'last quarter',
    });
    await analyzeAll();

    const scope = workspaceScope(db(), workspace.id);
    const filter: MetricScope = { period, repositoryIds: [repository.id] };
    const metrics = await teamMetrics(scope, filter);
    const list = await listPullRequests(scope, filter);

    expect(list.map((item) => item.title)).toEqual(['counted']);
    expect(list).toHaveLength(metrics.mergedCount);
  });

  it('sees nothing when no repository is visible to the viewer', async () => {
    const { workspace, repository, author } = await fixture();
    await seedPullRequest(db(), {
      workspaceId: workspace.id,
      repositoryId: repository.id,
      authorContributorId: author.id,
      mergedAt: at(4),
    });
    await analyzeAll();

    const metrics = await teamMetrics(workspaceScope(db(), workspace.id), {
      period,
      repositoryIds: [],
    });

    expect(metrics.mergedCount).toBe(0);
    expect(metrics.cycleTime.median).toBeNull();
  });

  it('keeps one workspace’s aggregates out of another’s', async () => {
    const first = await fixture();
    const second = await fixture();
    for (const context of [first, second]) {
      await seedPullRequest(db(), {
        workspaceId: context.workspace.id,
        repositoryId: context.repository.id,
        authorContributorId: context.author.id,
        mergedAt: at(4),
      });
    }
    await analyzeAll();

    const metrics = await teamMetrics(workspaceScope(db(), first.workspace.id), {
      period,
      // Even handed the other workspace's repository id, the scope keeps it out.
      repositoryIds: [first.repository.id, second.repository.id],
    });

    expect(metrics.mergedCount).toBe(1);
  });
});
