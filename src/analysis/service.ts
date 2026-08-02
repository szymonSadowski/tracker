/**
 * Analysis persistence: load a pull request's stored data, compute its metrics, write the single
 * `pr_analysis` row (design.md D5). The generated half of that row — the later LLM layer's
 * columns — is never touched here, so annotating a pull request and recomputing its metrics do
 * not interfere.
 */
import type { Database, Queryable } from '../db/driver';
import { computeMetrics, COMPUTED_VERSION, type MetricsInput } from './metrics';

interface PullRequestRow {
  id: string;
  workspace_id: string;
  repository_id: string;
  state: string;
  is_draft: boolean;
  author_contributor_id: string | null;
  author_is_bot: boolean | null;
  additions: number | null;
  deletions: number | null;
  changed_files: number | null;
  opened_at: Date;
  ready_for_review_at: Date | null;
  closed_at: Date | null;
  merged_at: Date | null;
}

export async function loadAnalysisInput(
  db: Queryable,
  pullRequestId: string,
): Promise<
  | undefined
  | (MetricsInput & {
      pullRequestId: string;
      workspaceId: string;
      repositoryId: string;
      state: string;
    })
> {
  const { rows } = await db.query<PullRequestRow>(
    `SELECT pr.*, c.is_bot AS author_is_bot
       FROM pull_requests pr
       LEFT JOIN contributors c ON c.id = pr.author_contributor_id
      WHERE pr.id = $1`,
    [pullRequestId],
  );
  const row = rows[0];
  if (!row) return undefined;

  const reviews = await db.query<{
    reviewer_contributor_id: string | null;
    reviewer_is_bot: boolean | null;
    state: string;
    submitted_at: Date;
  }>(
    `SELECT r.reviewer_contributor_id, r.state, r.submitted_at, c.is_bot AS reviewer_is_bot
       FROM pr_reviews r
       LEFT JOIN contributors c ON c.id = r.reviewer_contributor_id
      WHERE r.pull_request_id = $1
      ORDER BY r.submitted_at`,
    [pullRequestId],
  );

  const events = await db.query<{ event_type: string; occurred_at: Date }>(
    'SELECT event_type, occurred_at FROM pr_events WHERE pull_request_id = $1 ORDER BY occurred_at',
    [pullRequestId],
  );

  return {
    pullRequestId: row.id,
    workspaceId: row.workspace_id,
    repositoryId: row.repository_id,
    state: row.state,
    pullRequest: {
      openedAt: row.opened_at,
      readyForReviewAt: row.ready_for_review_at,
      mergedAt: row.merged_at,
      closedAt: row.closed_at,
      isDraft: row.is_draft,
      authorContributorId: row.author_contributor_id,
      authorIsBot: row.author_is_bot ?? false,
      additions: row.additions,
      deletions: row.deletions,
      changedFiles: row.changed_files,
    },
    reviews: reviews.rows.map((review) => ({
      reviewerContributorId: review.reviewer_contributor_id,
      reviewerIsBot: review.reviewer_is_bot ?? false,
      state: review.state,
      submittedAt: review.submitted_at,
    })),
    events: events.rows.map((event) => ({
      type: event.event_type,
      occurredAt: event.occurred_at,
    })),
  };
}

/** Compute and store the analysis record for one pull request. */
export async function analyzePullRequest(
  db: Queryable,
  pullRequestId: string,
): Promise<{ analyzed: boolean }> {
  const input = await loadAnalysisInput(db, pullRequestId);
  if (!input) return { analyzed: false };

  const metrics = computeMetrics(input);

  await db.query(
    `INSERT INTO pr_analysis
       (workspace_id, pull_request_id, repository_id, cycle_time_seconds, draft_duration_seconds,
        time_to_first_review_seconds, time_to_approval_seconds,
        time_to_merge_after_approval_seconds, review_cycles, post_review_pushes,
        additions, deletions, files_changed, size_bucket, author_contributor_id, author_is_bot,
        merged_at, opened_at, ready_for_review_at, pr_state, computed_at, computed_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now(),$21)
     ON CONFLICT (workspace_id, pull_request_id) DO UPDATE
       SET repository_id = EXCLUDED.repository_id,
           cycle_time_seconds = EXCLUDED.cycle_time_seconds,
           draft_duration_seconds = EXCLUDED.draft_duration_seconds,
           time_to_first_review_seconds = EXCLUDED.time_to_first_review_seconds,
           time_to_approval_seconds = EXCLUDED.time_to_approval_seconds,
           time_to_merge_after_approval_seconds = EXCLUDED.time_to_merge_after_approval_seconds,
           review_cycles = EXCLUDED.review_cycles,
           post_review_pushes = EXCLUDED.post_review_pushes,
           additions = EXCLUDED.additions,
           deletions = EXCLUDED.deletions,
           files_changed = EXCLUDED.files_changed,
           size_bucket = EXCLUDED.size_bucket,
           author_contributor_id = EXCLUDED.author_contributor_id,
           author_is_bot = EXCLUDED.author_is_bot,
           merged_at = EXCLUDED.merged_at,
           opened_at = EXCLUDED.opened_at,
           ready_for_review_at = EXCLUDED.ready_for_review_at,
           pr_state = EXCLUDED.pr_state,
           computed_at = now(),
           computed_version = EXCLUDED.computed_version`,
    [
      input.workspaceId,
      input.pullRequestId,
      input.repositoryId,
      metrics.cycleTimeSeconds,
      metrics.draftDurationSeconds,
      metrics.timeToFirstReviewSeconds,
      metrics.timeToApprovalSeconds,
      metrics.timeToMergeAfterApprovalSeconds,
      metrics.reviewCycles,
      metrics.postReviewPushes,
      metrics.additions,
      metrics.deletions,
      metrics.filesChanged,
      metrics.sizeBucket,
      input.pullRequest.authorContributorId,
      input.pullRequest.authorIsBot,
      input.pullRequest.mergedAt,
      input.pullRequest.openedAt,
      input.pullRequest.readyForReviewAt,
      input.state,
      metrics.computedVersion,
    ],
  );

  return { analyzed: true };
}

export interface RecomputeScope {
  workspaceId: string;
  repositoryId?: string;
  mergedAfter?: Date;
  mergedBefore?: Date;
  /** Only rows produced by an older definition revision. */
  staleOnly?: boolean;
}

/**
 * Bulk recompute from stored data only (spec: pr-metrics "Analysis is recomputable in bulk").
 * No GitHub request is made; a definition change is a batch job.
 */
export async function recomputeAnalysis(
  database: Database,
  scope: RecomputeScope,
): Promise<{ recomputed: number }> {
  const { rows } = await database.query<{ id: string }>(
    `SELECT pr.id
       FROM pull_requests pr
       LEFT JOIN pr_analysis a
         ON a.workspace_id = pr.workspace_id AND a.pull_request_id = pr.id
      WHERE pr.workspace_id = $1
        AND ($2::uuid IS NULL OR pr.repository_id = $2)
        AND ($3::timestamptz IS NULL OR pr.merged_at >= $3)
        AND ($4::timestamptz IS NULL OR pr.merged_at <= $4)
        AND ($5::boolean IS NOT TRUE OR a.computed_version IS DISTINCT FROM $6)
      ORDER BY pr.merged_at NULLS LAST`,
    [
      scope.workspaceId,
      scope.repositoryId ?? null,
      scope.mergedAfter ?? null,
      scope.mergedBefore ?? null,
      scope.staleOnly ?? false,
      COMPUTED_VERSION,
    ],
  );

  let recomputed = 0;
  for (const row of rows) {
    await database.transaction(async (tx) => {
      await analyzePullRequest(tx, row.id);
    });
    recomputed++;
  }
  return { recomputed };
}
