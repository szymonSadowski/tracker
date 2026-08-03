/**
 * Deterministic pull request metrics (spec: pr-metrics, anchors fixed in design.md D6).
 *
 * A pure function of stored data: no clock, no network, no randomness. Two runs over the same
 * input produce the same numbers, which is what makes recomputation safe and comparisons over
 * time honest.
 *
 * Anything that cannot be computed is `null`. Never zero — rendering an unreviewed pull request's
 * time-to-first-review as zero would make it look maximally fast.
 */

/**
 * The revision of these definitions. Bump it whenever a metric's meaning changes, so historical
 * rows stay explainable and a recompute can be targeted (design.md D5).
 */
import {
  classifyChurn,
  fileTotalLines,
  isExcludedPath,
  type ChurnCommitFile,
  type ChurnFile,
} from './churn';
import {
  definitionRevision,
  DEFAULT_METRIC_SETTINGS,
  type MetricSettings,
} from './settings';

export const COMPUTED_VERSION = 2;

export type SizeBucket = 'xs' | 's' | 'm' | 'l' | 'xl';

export interface MetricsPullRequest {
  openedAt: Date;
  readyForReviewAt: Date | null;
  /** The cycle time anchor (design.md D1). Null when commit history is unavailable. */
  firstCommitAt: Date | null;
  mergedAt: Date | null;
  closedAt: Date | null;
  isDraft: boolean;
  authorContributorId: string | null;
  authorIsBot: boolean;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  /** GitHub stopped enumerating this pull request's files; a complete list is unavailable. */
  filesTruncated: boolean;
  /** File data has been collected at least once. Distinguishes "none" from "never asked". */
  fileDataPresent: boolean;
  /** Review comment data has been collected. Zero comments and no data are different facts. */
  commentDataPresent: boolean;
}

export interface MetricsReview {
  reviewerContributorId: string | null;
  reviewerIsBot: boolean;
  state: string;
  submittedAt: Date;
}

export interface MetricsEvent {
  type: string;
  occurredAt: Date;
}

export interface MetricsReviewComment {
  authorContributorId: string | null;
  authorIsBot: boolean;
  submittedAt: Date;
}

export interface MetricsInput {
  pullRequest: MetricsPullRequest;
  reviews: readonly MetricsReview[];
  events: readonly MetricsEvent[];
  files?: readonly ChurnFile[];
  commitFiles?: readonly ChurnCommitFile[];
  reviewComments?: readonly MetricsReviewComment[];
  /** Most recent prior change to each changed path in our ingested history (design.md D2). */
  lastChangedByPath?: ReadonlyMap<string, Date>;
  settings?: MetricSettings;
}

/**
 * Which inputs a record had. A definition change can then be targeted at the rows it affects
 * rather than at every row (spec: "Metric definitions declare their revision and their inputs").
 */
export interface MetricInputPresence {
  firstCommit: boolean;
  humanReview: boolean;
  fileData: boolean;
  commitFileData: boolean;
  commentData: boolean;
}

export interface MetricsResult {
  cycleTimeSeconds: number | null;
  codingTimeSeconds: number | null;
  pickupTimeSeconds: number | null;
  reviewTimeSeconds: number | null;
  draftDurationSeconds: number | null;
  timeToFirstReviewSeconds: number | null;
  timeToApprovalSeconds: number | null;
  timeToMergeAfterApprovalSeconds: number | null;
  reviewCycles: number | null;
  postReviewPushes: number | null;
  additions: number | null;
  deletions: number | null;
  filesChanged: number | null;
  sizeBucket: SizeBucket | null;
  /** Churn line counts. All four are absent together, never partially. */
  newCodeLines: number | null;
  refactorLines: number | null;
  reworkLines: number | null;
  excludedLines: number | null;
  churnUsedRecencyEstimate: boolean | null;
  reviewDepth: number | null;
  /** Share in [0,1] of the change that survived unaltered after submission. */
  prMaturity: number | null;
  inputs: MetricInputPresence;
  computedVersion: number;
  definitionRevision: string;
}

const PUSH_EVENTS = new Set(['commit_pushed', 'head_ref_force_pushed']);

function secondsBetween(from: Date, to: Date): number | null {
  const seconds = Math.round((to.getTime() - from.getTime()) / 1000);
  // Anchors out of order mean the underlying timeline is not what we assume; report absence
  // rather than a negative duration that would poison a median.
  return seconds < 0 ? null : seconds;
}

/** Size bands over total lines touched. */
export function classifySize(
  additions: number | null,
  deletions: number | null,
): SizeBucket | null {
  if (additions === null && deletions === null) return null;
  const total = (additions ?? 0) + (deletions ?? 0);
  if (total < 10) return 'xs';
  if (total < 50) return 's';
  if (total < 250) return 'm';
  if (total < 1000) return 'l';
  return 'xl';
}

/**
 * Reviews that count as human review of someone else's work: not the author's own, not a bot's
 * (spec: pr-metrics "Bot review does not count as human review"), and not before the pull request
 * was ready for review.
 */
export function humanReviews(input: MetricsInput): MetricsReview[] {
  const { pullRequest } = input;
  const anchor = pullRequest.readyForReviewAt;
  return input.reviews
    .filter((review) => !review.reviewerIsBot)
    .filter(
      (review) =>
        review.reviewerContributorId === null ||
        review.reviewerContributorId !== pullRequest.authorContributorId,
    )
    .filter((review) => anchor === null || review.submittedAt >= anchor)
    .filter((review) => review.state !== 'PENDING')
    .sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());
}

/**
 * Review rounds: groups of review activity separated by a push. A single round can contain
 * several reviewers; two reviews with a push between them are two rounds. Counting rounds rather
 * than reviews measures iteration on the change, not how many people looked at it.
 */
export function countReviewRounds(
  reviews: readonly MetricsReview[],
  events: readonly MetricsEvent[],
): number {
  if (reviews.length === 0) return 0;
  const pushes = events
    .filter((event) => PUSH_EVENTS.has(event.type))
    .map((event) => event.occurredAt.getTime())
    .sort((a, b) => a - b);

  let rounds = 1;
  for (let i = 1; i < reviews.length; i++) {
    const previous = reviews[i - 1]!.submittedAt.getTime();
    const current = reviews[i]!.submittedAt.getTime();
    if (pushes.some((push) => push > previous && push <= current)) rounds++;
  }
  return rounds;
}

/**
 * Pushes after the first human review — the iteration the review prompted. Derived from push
 * events rather than surviving commit identifiers, so a force-push (which rewrites those
 * identifiers) degrades gracefully instead of corrupting the count.
 */
export function countPostReviewPushes(
  firstReviewAt: Date,
  events: readonly MetricsEvent[],
): number {
  return events.filter((event) => PUSH_EVENTS.has(event.type) && event.occurredAt > firstReviewAt)
    .length;
}

/**
 * Review comments by someone other than the author, and not by a bot — the conversation the
 * review actually carried, rather than how many people clicked approve.
 */
export function computeReviewDepth(input: MetricsInput): number | null {
  // Zero comments and no comment data are different facts and are reported differently.
  if (!input.pullRequest.commentDataPresent) return null;
  const authorId = input.pullRequest.authorContributorId;
  return (input.reviewComments ?? []).filter(
    (comment) =>
      !comment.authorIsBot &&
      (comment.authorContributorId === null || comment.authorContributorId !== authorId),
  ).length;
}

/**
 * The share of a merged change that was present when it was submitted and not subsequently
 * altered. Computed from recorded per-commit statistics rather than from surviving commit
 * identifiers, so a force-push leaves the record computable rather than in an error state.
 */
export function computePrMaturity(input: MetricsInput): number | null {
  const pr = input.pullRequest;
  const ready = pr.readyForReviewAt;
  if (pr.mergedAt === null || ready === null) return null;
  if (!pr.fileDataPresent || pr.filesTruncated) return null;

  const patterns = (input.settings ?? DEFAULT_METRIC_SETTINGS).churnExclusionPatterns;
  const included = (input.files ?? []).filter((file) => !isExcludedPath(file.path, patterns));
  const totalLines = included.reduce((sum, file) => sum + fileTotalLines(file), 0);
  if (totalLines === 0) return null;

  const commitFiles = input.commitFiles ?? [];
  if (commitFiles.length === 0) return null;

  const includedPaths = new Set(included.map((file) => file.path));
  const alteredAfterReady = commitFiles
    .filter((file) => file.committedAt > ready && includedPaths.has(file.path))
    .reduce((sum, file) => sum + fileTotalLines(file), 0);

  return Math.max(0, 1 - Math.min(1, alteredAfterReady / totalLines));
}

export function computeMetrics(input: MetricsInput): MetricsResult {
  const pr = input.pullRequest;
  const ready = pr.readyForReviewAt;
  const merged = pr.mergedAt;
  const firstCommit = pr.firstCommitAt;
  const settings = input.settings ?? DEFAULT_METRIC_SETTINGS;

  // Draft duration: creation → ready for review. Zero for a pull request opened ready; absent
  // while it is still a draft, because the interval has not ended.
  const draftDurationSeconds = ready === null ? null : secondsBetween(pr.openedAt, ready);

  const reviews = humanReviews(input);
  const firstReview = reviews[0];
  const firstApproval = reviews.find((review) => review.state === 'APPROVED');

  /**
   * Cycle time runs from the first commit to the merge (design.md D1). A commit recorded after
   * the pull request was ready means the branch was pushed to afterwards; the span still covers
   * the whole change, so the anchor is the earlier of the two. With no commit history at all the
   * metric falls back to the ready-for-review anchor and coding time is absent.
   */
  const cycleAnchor =
    firstCommit !== null && ready !== null
      ? new Date(Math.min(firstCommit.getTime(), ready.getTime()))
      : (firstCommit ?? ready);
  const cycleTimeSeconds =
    merged !== null && cycleAnchor !== null ? secondsBetween(cycleAnchor, merged) : null;

  // Coding time: first commit → ready for review. Clamped at zero rather than going negative when
  // the first recorded commit lands after the pull request was already open.
  const codingTimeSeconds =
    firstCommit !== null && ready !== null
      ? Math.max(0, Math.round((ready.getTime() - firstCommit.getTime()) / 1000))
      : null;

  // Pickup: ready → first human review. Review: first human review → merge. Both absent when no
  // human reviewed, while cycle time still computes.
  const pickupTimeSeconds =
    firstReview && ready ? secondsBetween(ready, firstReview.submittedAt) : null;
  const reviewTimeSeconds =
    firstReview && merged ? secondsBetween(firstReview.submittedAt, merged) : null;

  const anchor = ready;
  const timeToFirstReviewSeconds =
    firstReview && anchor ? secondsBetween(anchor, firstReview.submittedAt) : null;
  const timeToApprovalSeconds =
    firstApproval && anchor ? secondsBetween(anchor, firstApproval.submittedAt) : null;
  const timeToMergeAfterApprovalSeconds =
    firstApproval && merged ? secondsBetween(firstApproval.submittedAt, merged) : null;

  const churn = computeChurn(input, firstReview?.submittedAt ?? null);

  return {
    cycleTimeSeconds,
    codingTimeSeconds,
    pickupTimeSeconds,
    reviewTimeSeconds,
    draftDurationSeconds,
    timeToFirstReviewSeconds,
    timeToApprovalSeconds,
    timeToMergeAfterApprovalSeconds,
    reviewCycles: countReviewRounds(reviews, input.events),
    postReviewPushes: firstReview
      ? countPostReviewPushes(firstReview.submittedAt, input.events)
      : null,
    additions: pr.additions,
    deletions: pr.deletions,
    filesChanged: pr.changedFiles,
    sizeBucket: classifySize(pr.additions, pr.deletions),
    newCodeLines: churn?.newCodeLines ?? null,
    refactorLines: churn?.refactorLines ?? null,
    reworkLines: churn?.reworkLines ?? null,
    excludedLines: churn?.excludedLines ?? null,
    churnUsedRecencyEstimate: churn === null ? null : churn.usedRecencyEstimate,
    reviewDepth: computeReviewDepth(input),
    prMaturity: computePrMaturity(input),
    inputs: {
      firstCommit: firstCommit !== null,
      humanReview: firstReview !== undefined,
      fileData: pr.fileDataPresent && !pr.filesTruncated,
      commitFileData: (input.commitFiles ?? []).length > 0,
      commentData: pr.commentDataPresent,
    },
    computedVersion: COMPUTED_VERSION,
    definitionRevision: definitionRevision(settings),
  };
}

/**
 * Churn, or absence. Absent — never zero — for a pull request that has not merged, one whose file
 * data was never collected, and one whose file list GitHub truncated: a churn of zero would read
 * as "this change touched nothing", which is a claim none of those three support.
 */
function computeChurn(
  input: MetricsInput,
  firstReviewAt: Date | null,
): ReturnType<typeof classifyChurn> | null {
  const pr = input.pullRequest;
  if (pr.mergedAt === null) return null;
  if (!pr.fileDataPresent || pr.filesTruncated) return null;

  const files = input.files ?? [];
  if (files.length === 0) return null;

  const settings = input.settings ?? DEFAULT_METRIC_SETTINGS;
  const result = classifyChurn({
    files,
    commitFiles: input.commitFiles ?? [],
    firstReviewAt,
    lastChangedByPath: input.lastChangedByPath ?? new Map(),
    mergedAt: pr.mergedAt,
    reworkRecencyDays: settings.reworkRecencyDays,
    churnExclusionPatterns: settings.churnExclusionPatterns,
  });

  // Every line excluded leaves nothing to classify; a zero-line change is absent, not zero.
  if (result.newCodeLines + result.refactorLines + result.reworkLines === 0) {
    return result.excludedLines > 0 ? result : null;
  }
  return result;
}
