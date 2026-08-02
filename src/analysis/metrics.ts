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
export const COMPUTED_VERSION = 1;

export type SizeBucket = 'xs' | 's' | 'm' | 'l' | 'xl';

export interface MetricsPullRequest {
  openedAt: Date;
  readyForReviewAt: Date | null;
  mergedAt: Date | null;
  closedAt: Date | null;
  isDraft: boolean;
  authorContributorId: string | null;
  authorIsBot: boolean;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
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

export interface MetricsInput {
  pullRequest: MetricsPullRequest;
  reviews: readonly MetricsReview[];
  events: readonly MetricsEvent[];
}

export interface MetricsResult {
  cycleTimeSeconds: number | null;
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
  computedVersion: number;
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

export function computeMetrics(input: MetricsInput): MetricsResult {
  const pr = input.pullRequest;
  const ready = pr.readyForReviewAt;
  const merged = pr.mergedAt;

  // Draft duration: creation → ready for review. Zero for a pull request opened ready; absent
  // while it is still a draft, because the interval has not ended.
  const draftDurationSeconds = ready === null ? null : secondsBetween(pr.openedAt, ready);

  // Cycle time: ready for review → merged. Absent for an open pull request, and for one merged
  // straight from draft, which never had the anchor this metric is defined against.
  const cycleTimeSeconds = merged !== null && ready !== null ? secondsBetween(ready, merged) : null;

  const reviews = humanReviews(input);
  const firstReview = reviews[0];
  const firstApproval = reviews.find((review) => review.state === 'APPROVED');
  const anchor = ready;

  const timeToFirstReviewSeconds =
    firstReview && anchor ? secondsBetween(anchor, firstReview.submittedAt) : null;
  const timeToApprovalSeconds =
    firstApproval && anchor ? secondsBetween(anchor, firstApproval.submittedAt) : null;
  const timeToMergeAfterApprovalSeconds =
    firstApproval && merged ? secondsBetween(firstApproval.submittedAt, merged) : null;

  return {
    cycleTimeSeconds,
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
    computedVersion: COMPUTED_VERSION,
  };
}
