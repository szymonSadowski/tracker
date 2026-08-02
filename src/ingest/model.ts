/**
 * The internal normalized representation (design.md D2).
 *
 * Both API clients map into this shape at the boundary, and the normalizer only ever sees this.
 * That is what makes "the same pull request ingested by either path produces the same record" a
 * property of one function rather than a coincidence between two clients.
 */

export type PullRequestState = 'open' | 'closed' | 'merged';

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';

/**
 * Timeline events the metric layer depends on. Review effort is derived from these rather than
 * from commit identifiers, so a force-push does not corrupt it (design.md risks).
 */
export type PullRequestEventType =
  | 'ready_for_review'
  | 'convert_to_draft'
  | 'head_ref_force_pushed'
  | 'commit_pushed'
  | 'review_requested'
  | 'merged'
  | 'closed'
  | 'reopened';

export interface NormalizedActor {
  nodeId: string;
  login: string;
  /** GitHub's account type. 'Bot' and 'Mannequin' are classified as bots at ingest (D7). */
  accountType: string;
  githubUserId?: number | null;
  name?: string | null;
  avatarUrl?: string | null;
}

export interface NormalizedReview {
  nodeId: string;
  reviewer: NormalizedActor | null;
  state: ReviewState;
  submittedAt: Date;
  bodyPresent: boolean;
}

export interface NormalizedCommit {
  nodeId: string;
  oid: string | null;
  author: NormalizedActor | null;
  committedAt: Date;
  authoredAt: Date | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  messageHeadline: string | null;
}

export interface NormalizedEvent {
  type: PullRequestEventType;
  occurredAt: Date;
  actor: NormalizedActor | null;
  /** Stable across ingestions of the same event so replay rewrites the same row. */
  dedupeKey: string;
  details?: Record<string, unknown>;
}

export interface NormalizedPullRequest {
  nodeId: string;
  number: number;
  title: string;
  url: string | null;
  state: PullRequestState;
  isDraft: boolean;
  author: NormalizedActor | null;
  baseRef: string | null;
  headRef: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  openedAt: Date;
  /** NULL only while the pull request is still a draft (design.md D6). */
  readyForReviewAt: Date | null;
  closedAt: Date | null;
  mergedAt: Date | null;
  githubUpdatedAt: Date;
  reviews: NormalizedReview[];
  commits: NormalizedCommit[];
  events: NormalizedEvent[];
}

export function isBotAccount(accountType: string | null | undefined): boolean {
  const normalized = (accountType ?? '').toLowerCase();
  return normalized === 'bot' || normalized === 'mannequin';
}

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Derive the ready-for-review anchor.
 *
 * A pull request opened ready is ready at creation. One opened as a draft becomes ready at its
 * first ready-for-review event; while it is still a draft there is no anchor, and the metrics
 * that hang off it are absent rather than zero.
 */
export function deriveReadyForReviewAt(
  openedAt: Date,
  isDraft: boolean,
  events: readonly NormalizedEvent[],
): Date | null {
  const readyEvents = events
    .filter((event) => event.type === 'ready_for_review')
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  if (readyEvents.length > 0) return readyEvents[0]!.occurredAt;
  const wasEverDraft = events.some((event) => event.type === 'convert_to_draft');
  if (isDraft) return null;
  // No draft history at all: it was opened ready for review.
  return wasEverDraft ? null : openedAt;
}

export function resolveState(merged: boolean, closedAt: Date | null): PullRequestState {
  if (merged) return 'merged';
  return closedAt ? 'closed' : 'open';
}
