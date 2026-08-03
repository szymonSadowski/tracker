/**
 * Cycle time's phase decomposition, churn classification, review depth, and PR maturity
 * (spec: pr-metrics).
 */
import { describe, expect, it } from 'vitest';
import { databaseFixture } from '../helpers/db';
import {
  at,
  BASE_TIME,
  hours,
  seedCommitFile,
  seedContributor,
  seedFile,
  seedPullRequest,
  seedRepository,
  seedReview,
  seedReviewComment,
  seedWorkspace,
} from '../helpers/factories';
import { analyzePullRequest, recomputeAnalysis } from '../../src/analysis/service';
import { classifyChurn, matchesGlob } from '../../src/analysis/churn';
import { saveMetricSettings } from '../../src/analysis/settings';

const db = databaseFixture();

interface Analysis {
  cycle_time_seconds: number | null;
  coding_time_seconds: number | null;
  pickup_time_seconds: number | null;
  review_time_seconds: number | null;
  new_code_lines: number | null;
  refactor_lines: number | null;
  rework_lines: number | null;
  excluded_lines: number | null;
  churn_used_recency_estimate: boolean | null;
  review_depth: number | null;
  pr_maturity: number | null;
  has_file_data_input: boolean;
  has_first_commit_input: boolean;
  definition_revision: string | null;
}

async function analysisOf(pullRequestId: string): Promise<Analysis> {
  await db().transaction((tx) => analyzePullRequest(tx, pullRequestId));
  const { rows } = await db().query<Analysis>(
    'SELECT * FROM pr_analysis WHERE pull_request_id = $1',
    [pullRequestId],
  );
  return rows[0]!;
}

async function scenario() {
  const workspace = await seedWorkspace(db());
  const repository = await seedRepository(db(), workspace.id);
  const author = await seedContributor(db(), workspace.id, { login: 'ada' });
  const reviewer = await seedContributor(db(), workspace.id, { login: 'bob' });
  const bot = await seedContributor(db(), workspace.id, { login: 'dependabot', isBot: true });
  return { workspaceId: workspace.id, repositoryId: repository.id, author, reviewer, bot };
}

describe('cycle time decomposes into its phases', () => {
  it('splits a merged pull request into coding, pickup, and review', async () => {
    const { workspaceId, repositoryId, author, reviewer } = await scenario();
    // First commit 10 hours before ready, first review 2 hours after that, merged 4 hours later.
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      firstCommitAt: at(-10),
      openedAt: BASE_TIME,
      readyForReviewAt: BASE_TIME,
      mergedAt: at(6),
    });
    await seedReview(db(), {
      workspaceId,
      pullRequestId: pr.id,
      reviewerContributorId: reviewer.id,
      submittedAt: at(2),
    });

    const analysis = await analysisOf(pr.id);

    expect(analysis.coding_time_seconds).toBe(hours(10));
    expect(analysis.pickup_time_seconds).toBe(hours(2));
    expect(analysis.review_time_seconds).toBe(hours(4));
    expect(analysis.cycle_time_seconds).toBe(hours(16));
    expect(
      analysis.coding_time_seconds! + analysis.pickup_time_seconds! + analysis.review_time_seconds!,
    ).toBe(analysis.cycle_time_seconds);
  });

  it('clamps coding time to zero when the first commit lands after the pull request opened', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      firstCommitAt: at(2),
      openedAt: BASE_TIME,
      readyForReviewAt: BASE_TIME,
      mergedAt: at(6),
    });

    const analysis = await analysisOf(pr.id);

    expect(analysis.coding_time_seconds).toBe(0);
    // The anchor is the earlier of the two, so the span still covers the whole change.
    expect(analysis.cycle_time_seconds).toBe(hours(6));
  });

  it('leaves coding time absent and falls back to ready-for-review with no commit history', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      firstCommitAt: null,
      openedAt: BASE_TIME,
      readyForReviewAt: BASE_TIME,
      mergedAt: at(6),
    });

    const analysis = await analysisOf(pr.id);

    expect(analysis.coding_time_seconds).toBeNull();
    expect(analysis.cycle_time_seconds).toBe(hours(6));
    expect(analysis.has_first_commit_input).toBe(false);
  });

  it('leaves pickup and review absent when nobody reviewed, and still computes cycle time', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      firstCommitAt: at(-3),
      openedAt: BASE_TIME,
      readyForReviewAt: BASE_TIME,
      mergedAt: at(6),
    });

    const analysis = await analysisOf(pr.id);

    expect(analysis.pickup_time_seconds).toBeNull();
    expect(analysis.review_time_seconds).toBeNull();
    expect(analysis.cycle_time_seconds).toBe(hours(9));
  });
});

describe('code churn', () => {
  const merged = at(6);
  const patterns = ['**/*.lock'];

  it('classifies an added file entirely as new code', () => {
    const result = classifyChurn({
      files: [{ path: 'src/a.ts', additions: 200, deletions: 0, changeKind: 'added' }],
      commitFiles: [],
      firstReviewAt: null,
      lastChangedByPath: new Map(),
      mergedAt: merged,
      reworkRecencyDays: 21,
      churnExclusionPatterns: patterns,
    });

    expect(result).toMatchObject({ newCodeLines: 200, refactorLines: 0, reworkLines: 0 });
  });

  it('classifies a replacement of long-standing code as refactor', () => {
    const result = classifyChurn({
      files: [{ path: 'src/a.ts', additions: 50, deletions: 50, changeKind: 'modified' }],
      commitFiles: [],
      firstReviewAt: null,
      lastChangedByPath: new Map([['src/a.ts', new Date(merged.getTime() - 365 * 86400_000)]]),
      mergedAt: merged,
      reworkRecencyDays: 21,
      churnExclusionPatterns: patterns,
    });

    expect(result).toMatchObject({ newCodeLines: 0, refactorLines: 50, reworkLines: 0 });
    expect(result.usedRecencyEstimate).toBe(false);
  });

  it('classifies a replacement of recently written code as rework', () => {
    const result = classifyChurn({
      files: [{ path: 'src/a.ts', additions: 30, deletions: 30, changeKind: 'modified' }],
      commitFiles: [],
      firstReviewAt: null,
      lastChangedByPath: new Map([['src/a.ts', new Date(merged.getTime() - 3 * 86400_000)]]),
      mergedAt: merged,
      reworkRecencyDays: 21,
      churnExclusionPatterns: patterns,
    });

    expect(result).toMatchObject({ newCodeLines: 0, refactorLines: 0, reworkLines: 30 });
    expect(result.usedRecencyEstimate).toBe(true);
  });

  it('classifies lines changed after the first review as rework whatever their age', () => {
    const result = classifyChurn({
      files: [{ path: 'src/a.ts', additions: 40, deletions: 40, changeKind: 'modified' }],
      commitFiles: [
        {
          path: 'src/a.ts',
          additions: 40,
          deletions: 40,
          changeKind: 'modified',
          committedAt: at(5),
        },
      ],
      firstReviewAt: at(2),
      lastChangedByPath: new Map([['src/a.ts', new Date(merged.getTime() - 365 * 86400_000)]]),
      mergedAt: merged,
      reworkRecencyDays: 21,
      churnExclusionPatterns: patterns,
    });

    expect(result).toMatchObject({ newCodeLines: 0, refactorLines: 0, reworkLines: 40 });
    // The exact component alone accounted for it; no approximation was involved.
    expect(result.usedRecencyEstimate).toBe(false);
  });

  it('excludes matching paths from every category and from the total', () => {
    const result = classifyChurn({
      files: [
        { path: 'src/a.ts', additions: 10, deletions: 0, changeKind: 'added' },
        { path: 'pnpm.lock', additions: 900, deletions: 400, changeKind: 'modified' },
      ],
      commitFiles: [],
      firstReviewAt: null,
      lastChangedByPath: new Map(),
      mergedAt: merged,
      reworkRecencyDays: 21,
      churnExclusionPatterns: patterns,
    });

    expect(result).toMatchObject({ newCodeLines: 10, refactorLines: 0, reworkLines: 0 });
    expect(result.excludedLines).toBe(900);
  });

  it('matches globs across and within path segments', () => {
    expect(matchesGlob('a/b/package-lock.json', '**/package-lock.json')).toBe(true);
    expect(matchesGlob('package-lock.json', '**/package-lock.json')).toBe(true);
    expect(matchesGlob('src/vendor/x/y.ts', '**/vendor/**')).toBe(true);
    expect(matchesGlob('src/app.ts', '**/vendor/**')).toBe(false);
  });

  it('is absent, never zero, for a pull request with no ingested file data', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(6),
    });

    const analysis = await analysisOf(pr.id);

    expect(analysis.new_code_lines).toBeNull();
    expect(analysis.rework_lines).toBeNull();
    expect(analysis.has_file_data_input).toBe(false);
    // The latency and size metrics are unaffected.
    expect(analysis.cycle_time_seconds).toBe(hours(6));
  });

  it('is absent for a truncated file list rather than computed from part of it', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(6),
      filesTruncated: true,
    });
    await seedFile(db(), {
      workspaceId,
      pullRequestId: pr.id,
      path: 'src/a.ts',
      additions: 10,
      changeKind: 'added',
    });

    const analysis = await analysisOf(pr.id);

    expect(analysis.new_code_lines).toBeNull();
    expect(analysis.has_file_data_input).toBe(false);
  });

  it('is absent for a pull request that has not merged', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      state: 'open',
      mergedAt: null,
    });
    await seedFile(db(), {
      workspaceId,
      pullRequestId: pr.id,
      path: 'src/a.ts',
      additions: 10,
      changeKind: 'added',
    });

    const analysis = await analysisOf(pr.id);

    expect(analysis.new_code_lines).toBeNull();
  });

  it('reads the workspace rework window and records the definition revision', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(6),
    });
    await seedFile(db(), {
      workspaceId,
      pullRequestId: pr.id,
      path: 'src/a.ts',
      additions: 20,
      deletions: 20,
      changeKind: 'modified',
    });

    const before = await analysisOf(pr.id);
    await saveMetricSettings(db(), workspaceId, { reworkRecencyDays: 60 });
    const after = await analysisOf(pr.id);

    expect(before.definition_revision).not.toBeNull();
    expect(after.definition_revision).not.toBe(before.definition_revision);
  });
});

describe('review depth', () => {
  it('counts comments from other humans and excludes the author and bots', async () => {
    const { workspaceId, repositoryId, author, reviewer, bot } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(6),
    });
    for (let i = 0; i < 5; i++) {
      await seedReviewComment(db(), {
        workspaceId,
        pullRequestId: pr.id,
        authorContributorId: reviewer.id,
        submittedAt: at(2),
      });
    }
    for (let i = 0; i < 4; i++) {
      await seedReviewComment(db(), {
        workspaceId,
        pullRequestId: pr.id,
        authorContributorId: author.id,
        submittedAt: at(3),
      });
    }
    await seedReviewComment(db(), {
      workspaceId,
      pullRequestId: pr.id,
      authorContributorId: bot.id,
      submittedAt: at(3),
    });

    expect((await analysisOf(pr.id)).review_depth).toBe(5);
  });

  it('is absent when comment data was never collected, and zero when it was', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const uncollected = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(6),
    });
    const collected = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(6),
      reviewCommentsIngestedAt: at(6),
    });

    expect((await analysisOf(uncollected.id)).review_depth).toBeNull();
    expect((await analysisOf(collected.id)).review_depth).toBe(0);
  });
});

describe('PR maturity', () => {
  it('is 100% when nothing changed after the pull request became ready', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      openedAt: BASE_TIME,
      readyForReviewAt: BASE_TIME,
      mergedAt: at(6),
    });
    await seedFile(db(), {
      workspaceId,
      pullRequestId: pr.id,
      path: 'src/a.ts',
      additions: 200,
      changeKind: 'added',
    });
    await seedCommitFile(db(), {
      workspaceId,
      pullRequestId: pr.id,
      path: 'src/a.ts',
      additions: 200,
      changeKind: 'added',
      committedAt: at(-1),
    });

    expect((await analysisOf(pr.id)).pr_maturity).toBe(1);
  });

  it('is 75% when a quarter of the change was altered after submission', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      openedAt: BASE_TIME,
      readyForReviewAt: BASE_TIME,
      mergedAt: at(6),
    });
    await seedFile(db(), {
      workspaceId,
      pullRequestId: pr.id,
      path: 'src/a.ts',
      additions: 200,
      changeKind: 'added',
    });
    await seedCommitFile(db(), {
      workspaceId,
      pullRequestId: pr.id,
      path: 'src/a.ts',
      additions: 200,
      changeKind: 'added',
      committedAt: at(-1),
    });
    await seedCommitFile(db(), {
      workspaceId,
      pullRequestId: pr.id,
      path: 'src/a.ts',
      additions: 25,
      deletions: 50,
      changeKind: 'modified',
      committedAt: at(3),
    });

    expect((await analysisOf(pr.id)).pr_maturity).toBe(0.75);
  });
});

describe('recompute', () => {
  it('is deterministic at a fixed definition revision', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      firstCommitAt: at(-2),
      mergedAt: at(6),
    });
    await seedFile(db(), {
      workspaceId,
      pullRequestId: pr.id,
      path: 'src/a.ts',
      additions: 30,
      deletions: 10,
      changeKind: 'modified',
    });

    const first = await analysisOf(pr.id);
    await recomputeAnalysis(db(), { workspaceId });
    const { rows } = await db().query<Analysis>('SELECT * FROM pr_analysis');

    expect(rows[0]!.cycle_time_seconds).toBe(first.cycle_time_seconds);
    expect(rows[0]!.new_code_lines).toBe(first.new_code_lines);
    expect(rows[0]!.definition_revision).toBe(first.definition_revision);
  });

  it('skips records with no churn inputs when the churn family is targeted', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const withFiles = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(6),
    });
    await seedFile(db(), {
      workspaceId,
      pullRequestId: withFiles.id,
      path: 'src/a.ts',
      additions: 10,
      changeKind: 'added',
    });
    const withoutFiles = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(6),
    });
    await analysisOf(withFiles.id);
    await analysisOf(withoutFiles.id);

    const outcome = await recomputeAnalysis(db(), { workspaceId, family: 'churn' });

    expect(outcome.recomputed).toBe(1);
  });
});
