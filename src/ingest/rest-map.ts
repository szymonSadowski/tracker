/**
 * Maps REST payloads into the internal representation (design.md D2). Nothing downstream of here
 * knows this data came from REST.
 */
import { GITHUB_FILE_ENUMERATION_LIMIT } from '../github/graphql';
import type {
  RestCommit,
  RestCommitDetail,
  RestFile,
  RestPullRequest,
  RestReview,
  RestReviewComment,
  RestTimelineEvent,
  RestUser,
} from '../github/rest';
import { mapFileChangeKind } from './graphql-map';
import {
  deriveReadyForReviewAt,
  parseDate,
  resolveState,
  type NormalizedActor,
  type NormalizedCommit,
  type NormalizedCommitFiles,
  type NormalizedEvent,
  type NormalizedFile,
  type NormalizedPullRequest,
  type NormalizedReview,
  type NormalizedReviewComment,
  type PullRequestEventType,
  type ReviewState,
} from './model';

export function mapRestActor(user: RestUser | null | undefined): NormalizedActor | null {
  if (!user) return null;
  return {
    nodeId: user.node_id,
    login: user.login,
    accountType: user.type ?? 'User',
    githubUserId: user.id,
    name: user.name ?? null,
    avatarUrl: user.avatar_url ?? null,
  };
}

const TIMELINE_EVENTS: Record<string, PullRequestEventType> = {
  ready_for_review: 'ready_for_review',
  convert_to_draft: 'convert_to_draft',
  head_ref_force_pushed: 'head_ref_force_pushed',
  committed: 'commit_pushed',
  review_requested: 'review_requested',
  merged: 'merged',
  closed: 'closed',
  reopened: 'reopened',
};

export function mapRestTimeline(events: readonly RestTimelineEvent[]): NormalizedEvent[] {
  const mapped: NormalizedEvent[] = [];
  for (const event of events) {
    const type = TIMELINE_EVENTS[event.event];
    if (!type) continue;

    if (type === 'commit_pushed') {
      // A `committed` timeline entry carries the commit's own timestamps, not a created_at.
      const committer = event.committer as { date?: string } | undefined;
      const author = event.author as { date?: string } | undefined;
      const occurredAt = parseDate(committer?.date ?? author?.date);
      const sha = typeof event.sha === 'string' ? event.sha : undefined;
      if (!occurredAt || !sha) continue;
      mapped.push({
        type,
        occurredAt,
        actor: null,
        dedupeKey: `commit_pushed:${sha}`,
        details: { sha },
      });
      continue;
    }

    const occurredAt = parseDate(event.created_at);
    if (!occurredAt) continue;
    mapped.push({
      type,
      occurredAt,
      actor: mapRestActor(event.actor ?? null),
      dedupeKey: `${type}:${occurredAt.toISOString()}`,
    });
  }
  return mapped;
}

export function mapRestReview(review: RestReview): NormalizedReview | undefined {
  const submittedAt = parseDate(review.submitted_at);
  // A pending review has not been submitted; it is not a review event yet.
  if (!submittedAt) return undefined;
  return {
    nodeId: review.node_id,
    reviewer: mapRestActor(review.user),
    state: (review.state?.toUpperCase() as ReviewState) ?? 'COMMENTED',
    submittedAt,
    bodyPresent: Boolean(review.body && review.body.trim().length > 0),
  };
}

export function mapRestCommit(commit: RestCommit): NormalizedCommit | undefined {
  const committedAt = parseDate(commit.commit.committer?.date ?? commit.commit.author?.date);
  if (!committedAt) return undefined;
  return {
    nodeId: commit.node_id ?? commit.sha,
    oid: commit.sha,
    author: mapRestActor(commit.author),
    committedAt,
    authoredAt: parseDate(commit.commit.author?.date),
    additions: commit.stats?.additions ?? null,
    deletions: commit.stats?.deletions ?? null,
    changedFiles: null,
    messageHeadline: commit.commit.message?.split('\n')[0] ?? null,
  };
}

/** REST's `status` and GraphQL's `changeType` map onto the same six kinds (spec: identical records). */
export function mapRestFile(file: RestFile): NormalizedFile {
  return {
    path: file.filename,
    additions: file.additions ?? 0,
    deletions: file.deletions ?? 0,
    changeKind: mapFileChangeKind(file.status),
  };
}

export function mapRestReviewComment(
  comment: RestReviewComment,
): NormalizedReviewComment | undefined {
  const submittedAt = parseDate(comment.created_at);
  if (!submittedAt) return undefined;
  return {
    nodeId: comment.node_id,
    // REST exposes the review's numeric id, not its node id, so the link is left to the GraphQL
    // path; the comment itself is identical either way.
    reviewNodeId: null,
    author: mapRestActor(comment.user),
    submittedAt,
  };
}

export function mapRestCommitFiles(commit: RestCommitDetail): NormalizedCommitFiles | undefined {
  const committedAt = parseDate(commit.commit.committer?.date ?? commit.commit.author?.date);
  if (!committedAt) return undefined;
  return {
    commitNodeId: commit.node_id ?? commit.sha,
    commitOid: commit.sha,
    committedAt,
    files: (commit.files ?? []).map(mapRestFile),
  };
}

export interface RestPullRequestBundle {
  pullRequest: RestPullRequest;
  reviews: readonly RestReview[];
  commits: readonly RestCommit[];
  timeline: readonly RestTimelineEvent[];
  /** Omitted when this fetch did not ask for files; an empty array means it asked and found none. */
  files?: readonly RestFile[];
  reviewComments?: readonly RestReviewComment[];
  commitFiles?: readonly RestCommitDetail[];
}

export function mapRestPullRequest(bundle: RestPullRequestBundle): NormalizedPullRequest {
  const pr = bundle.pullRequest;
  const openedAt = parseDate(pr.created_at)!;
  const mergedAt = parseDate(pr.merged_at);
  const closedAt = parseDate(pr.closed_at);
  const events = mapRestTimeline(bundle.timeline);

  return {
    nodeId: pr.node_id,
    number: pr.number,
    title: pr.title ?? '',
    body: pr.body ?? null,
    url: pr.html_url ?? null,
    state: resolveState(mergedAt !== null, closedAt),
    isDraft: pr.draft ?? false,
    author: mapRestActor(pr.user),
    baseRef: pr.base?.ref ?? null,
    headRef: pr.head?.ref ?? null,
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    changedFiles: pr.changed_files ?? null,
    openedAt,
    readyForReviewAt: deriveReadyForReviewAt(openedAt, pr.draft ?? false, events),
    closedAt,
    mergedAt,
    githubUpdatedAt: parseDate(pr.updated_at) ?? openedAt,
    reviews: bundle.reviews
      .map(mapRestReview)
      .filter((review): review is NormalizedReview => review !== undefined),
    commits: bundle.commits
      .map(mapRestCommit)
      .filter((commit): commit is NormalizedCommit => commit !== undefined),
    events,
    files: bundle.files === undefined ? null : bundle.files.map(mapRestFile),
    // REST stops enumerating at the same limit GraphQL does; a list that arrives exactly at it is
    // recorded as truncated rather than assumed to be the whole change.
    filesTruncated: (bundle.files?.length ?? 0) >= GITHUB_FILE_ENUMERATION_LIMIT,
    reviewComments:
      bundle.reviewComments === undefined
        ? null
        : bundle.reviewComments
            .map(mapRestReviewComment)
            .filter((comment): comment is NormalizedReviewComment => comment !== undefined),
    // The comments endpoint returns every comment on the pull request, so the set can retire rows.
    reviewCommentsComplete: bundle.reviewComments !== undefined,
    commitFiles:
      bundle.commitFiles === undefined
        ? null
        : bundle.commitFiles
            .map(mapRestCommitFiles)
            .filter((commit): commit is NormalizedCommitFiles => commit !== undefined),
  };
}
