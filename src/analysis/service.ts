/**
 * Analysis persistence: load a pull request's stored data, compute its metrics, write the single
 * `pr_analysis` row (design.md D5). The generated half of that row — the later LLM layer's
 * columns — is never touched here, so annotating a pull request and recomputing its metrics do
 * not interfere.
 */
import type { Database, Queryable } from '../db/driver';
import type { FileChangeKind } from '../ingest/model';
import type { ChurnFile } from './churn';
import { computeMetrics, COMPUTED_VERSION, type MetricsInput } from './metrics';
import { loadMetricSettings } from './settings';

interface FileRow {
  path: string;
  additions: number;
  deletions: number;
  change_kind: FileChangeKind;
}

const toChurnFile = (row: FileRow): ChurnFile => ({
  path: row.path,
  additions: row.additions,
  deletions: row.deletions,
  changeKind: row.change_kind,
});

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
  first_commit_at: Date | null;
  closed_at: Date | null;
  merged_at: Date | null;
  files_truncated: boolean;
  files_ingested_at: Date | null;
  review_comments_ingested_at: Date | null;
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

  const files = await db.query<FileRow>(
    'SELECT path, additions, deletions, change_kind FROM pr_files WHERE pull_request_id = $1 ORDER BY path',
    [pullRequestId],
  );

  const commitFiles = await db.query<FileRow & { committed_at: Date }>(
    `SELECT path, additions, deletions, change_kind, committed_at
       FROM pr_commit_files WHERE pull_request_id = $1 ORDER BY committed_at, path`,
    [pullRequestId],
  );

  const reviewComments = await db.query<{
    author_contributor_id: string | null;
    author_is_bot: boolean | null;
    submitted_at: Date;
  }>(
    `SELECT rc.author_contributor_id, rc.submitted_at, c.is_bot AS author_is_bot
       FROM pr_review_comments rc
       LEFT JOIN contributors c ON c.id = rc.author_contributor_id
      WHERE rc.pull_request_id = $1
      ORDER BY rc.submitted_at`,
    [pullRequestId],
  );

  /**
   * When each changed path was last touched by an earlier merged pull request in the same
   * repository. This is the recency approximation's only input, and it can see exactly as far back
   * as our own coverage does (design.md D2).
   */
  const paths = files.rows.map((file) => file.path);
  const lastChangedByPath = new Map<string, Date>();
  if (paths.length > 0 && row.merged_at !== null) {
    const history = await db.query<{ path: string; last_changed_at: Date }>(
      `SELECT f.path, max(p.merged_at) AS last_changed_at
         FROM pr_files f
         JOIN pull_requests p ON p.id = f.pull_request_id
        WHERE f.workspace_id = $1
          AND p.repository_id = $2
          AND p.merged_at IS NOT NULL
          AND p.merged_at < $3
          AND f.pull_request_id <> $4
          AND f.path = ANY($5::text[])
        GROUP BY f.path`,
      [row.workspace_id, row.repository_id, row.merged_at, pullRequestId, paths],
    );
    for (const entry of history.rows) lastChangedByPath.set(entry.path, entry.last_changed_at);
  }

  const settings = await loadMetricSettings(db, row.workspace_id);

  return {
    pullRequestId: row.id,
    workspaceId: row.workspace_id,
    repositoryId: row.repository_id,
    state: row.state,
    pullRequest: {
      openedAt: row.opened_at,
      readyForReviewAt: row.ready_for_review_at,
      firstCommitAt: row.first_commit_at,
      mergedAt: row.merged_at,
      closedAt: row.closed_at,
      isDraft: row.is_draft,
      authorContributorId: row.author_contributor_id,
      authorIsBot: row.author_is_bot ?? false,
      additions: row.additions,
      deletions: row.deletions,
      changedFiles: row.changed_files,
      filesTruncated: row.files_truncated ?? false,
      fileDataPresent: row.files_ingested_at !== null,
      commentDataPresent: row.review_comments_ingested_at !== null,
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
    files: files.rows.map(toChurnFile),
    commitFiles: commitFiles.rows.map((row) => ({
      ...toChurnFile(row),
      committedAt: row.committed_at,
    })),
    reviewComments: reviewComments.rows.map((comment) => ({
      authorContributorId: comment.author_contributor_id,
      authorIsBot: comment.author_is_bot ?? false,
      submittedAt: comment.submitted_at,
    })),
    lastChangedByPath,
    settings,
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
        merged_at, opened_at, ready_for_review_at, pr_state, computed_at, computed_version,
        coding_time_seconds, pickup_time_seconds, review_time_seconds,
        new_code_lines, refactor_lines, rework_lines, excluded_lines,
        churn_used_recency_estimate, review_depth, pr_maturity,
        has_first_commit_input, has_human_review_input, has_file_data_input,
        has_commit_file_input, has_comment_data_input, definition_revision)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now(),$21,
             $22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37)
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
           computed_version = EXCLUDED.computed_version,
           coding_time_seconds = EXCLUDED.coding_time_seconds,
           pickup_time_seconds = EXCLUDED.pickup_time_seconds,
           review_time_seconds = EXCLUDED.review_time_seconds,
           new_code_lines = EXCLUDED.new_code_lines,
           refactor_lines = EXCLUDED.refactor_lines,
           rework_lines = EXCLUDED.rework_lines,
           excluded_lines = EXCLUDED.excluded_lines,
           churn_used_recency_estimate = EXCLUDED.churn_used_recency_estimate,
           review_depth = EXCLUDED.review_depth,
           pr_maturity = EXCLUDED.pr_maturity,
           has_first_commit_input = EXCLUDED.has_first_commit_input,
           has_human_review_input = EXCLUDED.has_human_review_input,
           has_file_data_input = EXCLUDED.has_file_data_input,
           has_commit_file_input = EXCLUDED.has_commit_file_input,
           has_comment_data_input = EXCLUDED.has_comment_data_input,
           definition_revision = EXCLUDED.definition_revision`,
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
      metrics.codingTimeSeconds,
      metrics.pickupTimeSeconds,
      metrics.reviewTimeSeconds,
      metrics.newCodeLines,
      metrics.refactorLines,
      metrics.reworkLines,
      metrics.excludedLines,
      metrics.churnUsedRecencyEstimate,
      metrics.reviewDepth,
      metrics.prMaturity,
      metrics.inputs.firstCommit,
      metrics.inputs.humanReview,
      metrics.inputs.fileData,
      metrics.inputs.commitFileData,
      metrics.inputs.commentData,
      metrics.definitionRevision,
    ],
  );

  return { analyzed: true };
}

/**
 * Which family of definitions changed. A churn-only revision has no reason to touch a record that
 * never had file inputs, so the recompute can skip it entirely (spec: pr-metrics "A churn-only
 * definition change is released").
 */
export type MetricFamily = 'all' | 'churn' | 'latency' | 'review';

export interface RecomputeScope {
  workspaceId: string;
  repositoryId?: string;
  mergedAfter?: Date;
  mergedBefore?: Date;
  /** Only rows produced by an older definition revision. */
  staleOnly?: boolean;
  /** Restrict to the records a change to this family of metrics can actually affect. */
  family?: MetricFamily;
}

/** The input-presence flag a family depends on; `all` depends on none of them. */
const FAMILY_INPUT_COLUMN: Record<MetricFamily, string | null> = {
  all: null,
  churn: 'has_file_data_input',
  latency: 'has_first_commit_input',
  review: 'has_comment_data_input',
};

/**
 * Bulk recompute from stored data only (spec: pr-metrics "Analysis is recomputable in bulk").
 * No GitHub request is made; a definition change is a batch job.
 */
export async function recomputeAnalysis(
  database: Database,
  scope: RecomputeScope,
): Promise<{ recomputed: number }> {
  const family = scope.family ?? 'all';
  const inputColumn = FAMILY_INPUT_COLUMN[family];
  // A record with no analysis row yet is never skipped: it has no flags to judge it by.
  const familyClause = inputColumn
    ? `AND (a.pull_request_id IS NULL OR a.${inputColumn} = true)`
    : '';

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
        ${familyClause}
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
