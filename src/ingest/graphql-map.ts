/** Maps GraphQL payloads into the internal representation (design.md D2). */
import type { GraphQLActor, GraphQLPullRequestNode } from '../github/graphql';
import {
  deriveReadyForReviewAt,
  parseDate,
  resolveState,
  type NormalizedActor,
  type NormalizedCommit,
  type NormalizedEvent,
  type NormalizedPullRequest,
  type NormalizedReview,
  type PullRequestEventType,
  type ReviewState,
} from './model';

export function mapGraphQLActor(actor: GraphQLActor | null | undefined): NormalizedActor | null {
  if (!actor || !actor.id || !actor.login) return null;
  return {
    nodeId: actor.id,
    login: actor.login,
    // GraphQL reports the account kind as the GraphQL type name.
    accountType: actor.__typename ?? 'User',
    githubUserId: actor.databaseId ?? null,
    name: actor.name ?? null,
    avatarUrl: actor.avatarUrl ?? null,
  };
}

const TIMELINE_TYPES: Record<string, PullRequestEventType> = {
  ReadyForReviewEvent: 'ready_for_review',
  ConvertToDraftEvent: 'convert_to_draft',
  HeadRefForcePushedEvent: 'head_ref_force_pushed',
  ReviewRequestedEvent: 'review_requested',
  MergedEvent: 'merged',
  ClosedEvent: 'closed',
  ReopenedEvent: 'reopened',
};

export function mapGraphQLTimeline(
  nodes: readonly (Record<string, unknown> & { __typename: string })[],
): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  for (const node of nodes) {
    const type = TIMELINE_TYPES[node.__typename];
    if (!type) continue;
    const occurredAt = parseDate(node.createdAt as string | undefined);
    if (!occurredAt) continue;
    events.push({
      type,
      occurredAt,
      actor: mapGraphQLActor(node.actor as GraphQLActor | null),
      // Matches the REST mapper's key so the two paths write the same row.
      dedupeKey: `${type}:${occurredAt.toISOString()}`,
    });
  }
  return events;
}

/**
 * Commits also appear as push events. Review effort counts pushes after the first review, and a
 * commit's presence is the only push signal GraphQL gives cheaply.
 */
function commitEvents(node: GraphQLPullRequestNode): NormalizedEvent[] {
  return (node.commits?.nodes ?? []).flatMap((entry) => {
    const occurredAt = parseDate(entry.commit.committedDate);
    if (!occurredAt) return [];
    return [
      {
        type: 'commit_pushed' as const,
        occurredAt,
        actor: mapGraphQLActor(entry.commit.author?.user ?? null),
        dedupeKey: `commit_pushed:${entry.commit.oid}`,
        details: { sha: entry.commit.oid },
      },
    ];
  });
}

export function mapGraphQLPullRequest(node: GraphQLPullRequestNode): NormalizedPullRequest {
  const openedAt = parseDate(node.createdAt)!;
  const mergedAt = parseDate(node.mergedAt);
  const closedAt = parseDate(node.closedAt);
  const events = [...mapGraphQLTimeline(node.timelineItems?.nodes ?? []), ...commitEvents(node)];

  const reviews: NormalizedReview[] = (node.reviews?.nodes ?? []).flatMap((review) => {
    const submittedAt = parseDate(review.submittedAt);
    if (!submittedAt) return [];
    return [
      {
        nodeId: review.id,
        reviewer: mapGraphQLActor(review.author),
        state: (review.state?.toUpperCase() as ReviewState) ?? 'COMMENTED',
        submittedAt,
        bodyPresent: Boolean(review.bodyText && review.bodyText.trim().length > 0),
      },
    ];
  });

  const commits: NormalizedCommit[] = (node.commits?.nodes ?? []).flatMap((entry) => {
    const committedAt = parseDate(entry.commit.committedDate);
    if (!committedAt) return [];
    return [
      {
        nodeId: entry.commit.id,
        oid: entry.commit.oid,
        author: mapGraphQLActor(entry.commit.author?.user ?? null),
        committedAt,
        authoredAt: parseDate(entry.commit.authoredDate),
        additions: entry.commit.additions ?? null,
        deletions: entry.commit.deletions ?? null,
        changedFiles: entry.commit.changedFilesIfAvailable ?? null,
        messageHeadline: entry.commit.messageHeadline ?? null,
      },
    ];
  });

  return {
    nodeId: node.id,
    number: node.number,
    title: node.title ?? '',
    url: node.url ?? null,
    state: resolveState(mergedAt !== null, closedAt),
    isDraft: node.isDraft ?? false,
    author: mapGraphQLActor(node.author),
    baseRef: node.baseRefName ?? null,
    headRef: node.headRefName ?? null,
    additions: node.additions ?? null,
    deletions: node.deletions ?? null,
    changedFiles: node.changedFiles ?? null,
    openedAt,
    readyForReviewAt: deriveReadyForReviewAt(openedAt, node.isDraft ?? false, events),
    closedAt,
    mergedAt,
    githubUpdatedAt: parseDate(node.updatedAt) ?? openedAt,
    reviews,
    commits,
    events,
  };
}
