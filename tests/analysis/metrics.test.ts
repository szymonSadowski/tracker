import { describe, expect, it } from 'vitest';
import { databaseFixture } from '../helpers/db';
import {
  at,
  BASE_TIME,
  hours,
  seedCommit,
  seedContributor,
  seedEvent,
  seedPullRequest,
  seedRepository,
  seedReview,
  seedWorkspace,
} from '../helpers/factories';
import { analyzePullRequest, recomputeAnalysis } from '../../src/analysis/service';
import { classifySize, computeMetrics, COMPUTED_VERSION } from '../../src/analysis/metrics';

const db = databaseFixture();

interface Analysis {
  cycle_time_seconds: number | null;
  draft_duration_seconds: number | null;
  time_to_first_review_seconds: number | null;
  time_to_approval_seconds: number | null;
  time_to_merge_after_approval_seconds: number | null;
  review_cycles: number | null;
  post_review_pushes: number | null;
  size_bucket: string | null;
  additions: number | null;
  computed_version: number;
  author_is_bot: boolean;
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

describe('pull request metrics', () => {
  it('measures draft time and cycle time from their own anchors', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    // Opened as a draft, ready 2 hours later, merged 6 hours after that.
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      openedAt: BASE_TIME,
      readyForReviewAt: at(2),
      mergedAt: at(8),
    });

    const analysis = await analysisOf(pr.id);

    expect(analysis.draft_duration_seconds).toBe(hours(2));
    expect(analysis.cycle_time_seconds).toBe(hours(6));
  });

  it('treats a pull request opened ready as having no draft time', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      openedAt: BASE_TIME,
      readyForReviewAt: BASE_TIME,
      mergedAt: at(5),
    });

    const analysis = await analysisOf(pr.id);

    expect(analysis.draft_duration_seconds).toBe(0);
    expect(analysis.cycle_time_seconds).toBe(hours(5));
  });

  it('leaves review metrics absent — not zero — when a pull request merges unreviewed', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(4),
    });

    const analysis = await analysisOf(pr.id);

    expect(analysis.time_to_first_review_seconds).toBeNull();
    expect(analysis.time_to_approval_seconds).toBeNull();
    expect(analysis.time_to_merge_after_approval_seconds).toBeNull();
    expect(analysis.cycle_time_seconds).toBe(hours(4));
  });

  it('leaves cycle time absent while a pull request is open, but computes what it can', async () => {
    const { workspaceId, repositoryId, author, reviewer } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      state: 'open',
      mergedAt: null,
      closedAt: null,
    });
    await seedReview(db(), {
      workspaceId,
      pullRequestId: pr.id,
      reviewerContributorId: reviewer.id,
      submittedAt: at(3),
    });

    const analysis = await analysisOf(pr.id);

    expect(analysis.cycle_time_seconds).toBeNull();
    expect(analysis.time_to_first_review_seconds).toBe(hours(3));
  });

  it('counts review rounds and the pushes a review prompted', async () => {
    const { workspaceId, repositoryId, author, reviewer } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(10),
    });
    // review → push → push → review → merge
    await seedReview(db(), {
      workspaceId,
      pullRequestId: pr.id,
      reviewerContributorId: reviewer.id,
      state: 'CHANGES_REQUESTED',
      submittedAt: at(2),
    });
    await seedEvent(db(), {
      workspaceId,
      pullRequestId: pr.id,
      eventType: 'commit_pushed',
      occurredAt: at(3),
    });
    await seedEvent(db(), {
      workspaceId,
      pullRequestId: pr.id,
      eventType: 'commit_pushed',
      occurredAt: at(4),
    });
    await seedReview(db(), {
      workspaceId,
      pullRequestId: pr.id,
      reviewerContributorId: reviewer.id,
      state: 'APPROVED',
      submittedAt: at(5),
    });

    const analysis = await analysisOf(pr.id);

    expect(analysis.review_cycles).toBe(2);
    expect(analysis.post_review_pushes).toBe(2);
    expect(analysis.time_to_approval_seconds).toBe(hours(5));
    expect(analysis.time_to_merge_after_approval_seconds).toBe(hours(5));
  });

  it('keeps review effort computable when the branch is force-pushed', async () => {
    const { workspaceId, repositoryId, author, reviewer } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(9),
    });
    await seedReview(db(), {
      workspaceId,
      pullRequestId: pr.id,
      reviewerContributorId: reviewer.id,
      state: 'CHANGES_REQUESTED',
      submittedAt: at(2),
    });
    // The rewrite: the earlier commits no longer exist, only the force-push event does.
    await seedEvent(db(), {
      workspaceId,
      pullRequestId: pr.id,
      eventType: 'head_ref_force_pushed',
      occurredAt: at(4),
    });
    await seedCommit(db(), {
      workspaceId,
      pullRequestId: pr.id,
      committedAt: at(4),
      nodeId: 'rewritten-sha',
    });
    await seedReview(db(), {
      workspaceId,
      pullRequestId: pr.id,
      reviewerContributorId: reviewer.id,
      state: 'APPROVED',
      submittedAt: at(6),
    });

    const analysis = await analysisOf(pr.id);

    expect(analysis.post_review_pushes).toBe(1);
    expect(analysis.review_cycles).toBe(2);
    expect(analysis.cycle_time_seconds).toBe(hours(9));
  });

  it('does not count a bot’s review as review', async () => {
    const { workspaceId, repositoryId, author, bot } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(6),
    });
    await seedReview(db(), {
      workspaceId,
      pullRequestId: pr.id,
      reviewerContributorId: bot.id,
      state: 'APPROVED',
      submittedAt: at(1),
    });

    const analysis = await analysisOf(pr.id);

    expect(analysis.time_to_first_review_seconds).toBeNull();
    expect(analysis.time_to_approval_seconds).toBeNull();
  });

  it('does not count the author reviewing their own pull request', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(6),
    });
    await seedReview(db(), {
      workspaceId,
      pullRequestId: pr.id,
      reviewerContributorId: author.id,
      state: 'COMMENTED',
      submittedAt: at(1),
    });

    expect((await analysisOf(pr.id)).time_to_first_review_seconds).toBeNull();
  });

  it('marks a bot-authored pull request so aggregates can exclude it', async () => {
    const { workspaceId, repositoryId, bot } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: bot.id,
      mergedAt: at(1),
    });

    expect((await analysisOf(pr.id)).author_is_bot).toBe(true);
  });

  it('classifies change size from lines touched', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      additions: 2000,
      deletions: 1800,
      changedFiles: 40,
      mergedAt: at(20),
    });

    const analysis = await analysisOf(pr.id);

    expect(analysis.size_bucket).toBe('xl');
    expect(analysis.additions).toBe(2000);
    expect(classifySize(5, 2)).toBe('xs');
    expect(classifySize(30, 5)).toBe('s');
    expect(classifySize(100, 100)).toBe('m');
    expect(classifySize(500, 200)).toBe('l');
    expect(classifySize(null, null)).toBeNull();
  });

  it('is a pure function of its input', () => {
    const input = {
      pullRequest: {
        openedAt: BASE_TIME,
        readyForReviewAt: BASE_TIME,
        firstCommitAt: at(-1),
        mergedAt: at(4),
        closedAt: at(4),
        isDraft: false,
        authorContributorId: 'a',
        authorIsBot: false,
        additions: 10,
        deletions: 5,
        changedFiles: 2,
        filesTruncated: false,
        fileDataPresent: false,
        commentDataPresent: false,
      },
      reviews: [
        {
          reviewerContributorId: 'b',
          reviewerIsBot: false,
          state: 'APPROVED',
          submittedAt: at(1),
        },
      ],
      events: [{ type: 'commit_pushed', occurredAt: at(2) }],
    };

    expect(computeMetrics(input)).toEqual(computeMetrics(input));
    expect(computeMetrics(input).computedVersion).toBe(COMPUTED_VERSION);
  });

  it('recomputes in bulk from stored data and stamps the definition revision', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(6),
    });
    await analysisOf(pr.id);

    // Simulate a row produced by an older definition revision.
    await db().query('UPDATE pr_analysis SET computed_version = 0, cycle_time_seconds = 1');

    const outcome = await recomputeAnalysis(db(), { workspaceId });

    expect(outcome.recomputed).toBe(1);
    const { rows } = await db().query<{ computed_version: number; cycle_time_seconds: number }>(
      'SELECT computed_version, cycle_time_seconds FROM pr_analysis',
    );
    expect(rows[0]!.computed_version).toBe(COMPUTED_VERSION);
    expect(rows[0]!.cycle_time_seconds).toBe(hours(6));
  });

  it('leaves the generated columns untouched when metrics are recomputed', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const pr = await seedPullRequest(db(), {
      workspaceId,
      repositoryId,
      authorContributorId: author.id,
      mergedAt: at(6),
    });
    await analysisOf(pr.id);
    await db().query(
      "UPDATE pr_analysis SET summary = 'a later capability wrote this', analysis_skill_version = 'v2'",
    );

    await analysisOf(pr.id);

    const { rows } = await db().query<{ summary: string; analysis_skill_version: string }>(
      'SELECT summary, analysis_skill_version FROM pr_analysis',
    );
    expect(rows[0]).toEqual({
      summary: 'a later capability wrote this',
      analysis_skill_version: 'v2',
    });
  });
});
