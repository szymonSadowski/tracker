/** Maps GraphQL payloads into the internal representation (design.md D2). */
import {
  GITHUB_FILE_ENUMERATION_LIMIT,
  type GraphQLActor,
  type GraphQLFileConnection,
  type GraphQLFileNode,
  type GraphQLPullRequestNode,
  type GraphQLReviewCommentNode,
} from '../github/graphql';
import {
  deriveReadyForReviewAt,
  parseDate,
  resolveState,
  type FileChangeKind,
  type NormalizedActor,
  type NormalizedCommit,
  type NormalizedEvent,
  type NormalizedFile,
  type NormalizedPullRequest,
  type NormalizedReview,
  type NormalizedReviewComment,
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

/**
 * GitHub's change types. Both paths map onto the same six kinds, so a file record's content does
 * not depend on which one produced it (spec: "All ingestion paths produce identical records").
 */
const FILE_CHANGE_KINDS: Record<string, FileChangeKind> = {
  ADDED: 'added',
  MODIFIED: 'modified',
  DELETED: 'removed',
  REMOVED: 'removed',
  RENAMED: 'renamed',
  COPIED: 'copied',
  CHANGED: 'changed',
};

export function mapFileChangeKind(value: string | null | undefined): FileChangeKind {
  return FILE_CHANGE_KINDS[(value ?? '').toUpperCase()] ?? 'modified';
}

export function mapGraphQLFile(node: GraphQLFileNode): NormalizedFile {
  return {
    path: node.path,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    changeKind: mapFileChangeKind(node.changeType),
  };
}

export interface MappedFiles {
  files: NormalizedFile[];
  hasNextPage: boolean;
  endCursor: string | null;
  /** The list is known to be shorter than the change actually was. */
  truncated: boolean;
}

/**
 * A file connection, with the two things the caller needs to know beyond its contents: whether
 * more pages remain, and whether GitHub will refuse to enumerate the rest at all. A pull request
 * past the enumeration limit is recorded as truncated rather than treated as complete.
 */
export function mapGraphQLFiles(connection: GraphQLFileConnection | null | undefined): MappedFiles {
  if (!connection) {
    return { files: [], hasNextPage: false, endCursor: null, truncated: false };
  }
  const total = connection.totalCount ?? null;
  return {
    files: (connection.nodes ?? []).map(mapGraphQLFile),
    hasNextPage: connection.pageInfo.hasNextPage,
    endCursor: connection.pageInfo.endCursor,
    truncated: total !== null && total > GITHUB_FILE_ENUMERATION_LIMIT,
  };
}

function mapReviewComment(
  node: GraphQLReviewCommentNode & { pullRequestReview?: { id: string } | null },
  reviewNodeId: string | null,
): NormalizedReviewComment | undefined {
  const submittedAt = parseDate(node.createdAt);
  if (!submittedAt) return undefined;
  return {
    nodeId: node.id,
    reviewNodeId: node.pullRequestReview?.id ?? reviewNodeId,
    author: mapGraphQLActor(node.author),
    submittedAt,
  };
}

/**
 * Review comments from both connections GitHub exposes. They overlap — a diff comment belongs to
 * an implicit review — so the result is deduplicated by node id here rather than at the database.
 *
 * Returns `null` when neither connection was requested, which persistence reads as "this path did
 * not look" and leaves stored comments alone.
 */
export function mapGraphQLReviewComments(
  node: Pick<GraphQLPullRequestNode, 'reviews' | 'reviewThreads'>,
): NormalizedReviewComment[] | null {
  const reviewsRequested = (node.reviews?.nodes ?? []).some(
    (review) => review.comments !== undefined,
  );
  if (!reviewsRequested && node.reviewThreads === undefined) return null;

  const byNodeId = new Map<string, NormalizedReviewComment>();
  for (const review of node.reviews?.nodes ?? []) {
    for (const comment of review.comments?.nodes ?? []) {
      const mapped = mapReviewComment(comment, review.id);
      if (mapped) byNodeId.set(mapped.nodeId, mapped);
    }
  }
  for (const thread of node.reviewThreads?.nodes ?? []) {
    for (const comment of thread.comments?.nodes ?? []) {
      const mapped = mapReviewComment(comment, null);
      if (mapped) byNodeId.set(mapped.nodeId, mapped);
    }
  }
  return [...byNodeId.values()].sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());
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

  const mappedFiles = mapGraphQLFiles(node.files);

  return {
    nodeId: node.id,
    number: node.number,
    title: node.title ?? '',
    body: node.bodyText ?? null,
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
    // `files` absent from the selection means this path did not ask; an empty connection means it
    // asked and the pull request changed nothing.
    files: node.files === undefined ? null : mappedFiles.files,
    filesTruncated: mappedFiles.truncated,
    reviewComments: mapGraphQLReviewComments(node),
    // Per-commit statistics are not available on the GraphQL commit connection; the fill-in pass
    // collects them over REST (design.md D2).
    commitFiles: null,
  };
}

/** Whether the pull request's file list needs paging beyond what the bulk query returned. */
export function graphQLFilesPaging(node: GraphQLPullRequestNode): MappedFiles {
  return mapGraphQLFiles(node.files);
}
