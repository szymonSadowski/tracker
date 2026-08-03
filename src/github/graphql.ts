/**
 * GraphQL client for backfill (design.md D2).
 *
 * One paginated query returns each pull request with its reviews, commits, diff statistics, and
 * the timeline events the metrics need. The REST equivalent is three to four requests per pull
 * request, which does not survive a 90-day backfill of an active repository.
 */
import { githubRequest, type RateLimitSnapshot } from './http';
import { PermanentError, RetryableError } from '../jobs/errors';

export interface GraphQLClientOptions {
  graphqlUrl: string;
  token: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
  onRateLimit?: (snapshot: RateLimitSnapshot) => void;
}

export interface GraphQLActor {
  __typename?: string;
  login?: string;
  id?: string;
  databaseId?: number | null;
  name?: string | null;
  avatarUrl?: string | null;
}

export interface GraphQLPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface GraphQLFileNode {
  path: string;
  additions: number | null;
  deletions: number | null;
  changeType: string | null;
}

export interface GraphQLFileConnection {
  totalCount: number | null;
  pageInfo: GraphQLPageInfo;
  nodes: GraphQLFileNode[] | null;
}

export interface GraphQLReviewCommentNode {
  id: string;
  createdAt: string | null;
  author: GraphQLActor | null;
}

export interface GraphQLPullRequestNode {
  id: string;
  number: number;
  title: string;
  bodyText?: string | null;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  baseRefName: string | null;
  headRefName: string | null;
  author: GraphQLActor | null;
  files?: GraphQLFileConnection | null;
  reviews: {
    nodes: {
      id: string;
      state: string;
      submittedAt: string | null;
      bodyText?: string | null;
      author: GraphQLActor | null;
      comments?: { nodes: GraphQLReviewCommentNode[] | null } | null;
    }[];
  } | null;
  reviewThreads?: {
    nodes:
      | {
          comments: {
            nodes:
              | (GraphQLReviewCommentNode & { pullRequestReview: { id: string } | null })[]
              | null;
          } | null;
        }[]
      | null;
  } | null;
  commits: {
    nodes: {
      commit: {
        id: string;
        oid: string;
        messageHeadline: string | null;
        additions: number | null;
        deletions: number | null;
        changedFilesIfAvailable: number | null;
        committedDate: string;
        authoredDate: string | null;
        author: { user: GraphQLActor | null } | null;
      };
    }[];
  } | null;
  timelineItems: {
    nodes: (Record<string, unknown> & { __typename: string })[];
  } | null;
}

export interface PullRequestPage {
  nodes: GraphQLPullRequestNode[];
  endCursor: string | null;
  hasNextPage: boolean;
  rateLimit: { remaining: number; resetAt: string } | undefined;
}

/**
 * Files per page. Folded into the pull request query so ongoing sync costs no extra round trip
 * (design.md D5); a pull request with more files than this is paged separately.
 */
export const FILES_PAGE_SIZE = 100;

/**
 * How many files GitHub will enumerate for one pull request. Beyond it the list is truncated,
 * which is recorded rather than silently treated as complete.
 */
export const GITHUB_FILE_ENUMERATION_LIMIT = 3000;

/**
 * Comments per review in the bulk query. Kept modest because the connection multiplies with the
 * page size; the per-pull-request query below fetches the full set when depth matters.
 */
export const REVIEW_COMMENTS_PAGE_SIZE = 20;

/**
 * The node selection both paged queries share, so the two paths normalize identically and a
 * change to what is fetched cannot drift between them.
 */
const PULL_REQUEST_NODE_SELECTION = `
        id number title bodyText url isDraft createdAt updatedAt closedAt mergedAt
        additions deletions changedFiles baseRefName headRefName
        files(first: ${FILES_PAGE_SIZE}) {
          totalCount
          pageInfo { hasNextPage endCursor }
          nodes { path additions deletions changeType }
        }
        author {
          __typename
          login
          ... on User { id databaseId name avatarUrl }
          ... on Bot { id databaseId avatarUrl }
          ... on Organization { id databaseId name avatarUrl }
        }
        reviews(first: 100) {
          nodes {
            id state submittedAt bodyText
            author {
              __typename
              login
              ... on User { id databaseId name avatarUrl }
              ... on Bot { id databaseId avatarUrl }
            }
            comments(first: ${REVIEW_COMMENTS_PAGE_SIZE}) {
              nodes {
                id createdAt
                author {
                  __typename
                  login
                  ... on User { id databaseId name avatarUrl }
                  ... on Bot { id databaseId avatarUrl }
                }
              }
            }
          }
        }
        commits(first: 100) {
          nodes {
            commit {
              id oid messageHeadline additions deletions changedFilesIfAvailable
              committedDate authoredDate
              author {
                user {
                  __typename
                  login
                  ... on User { id databaseId name avatarUrl }
                }
              }
            }
          }
        }
        timelineItems(
          first: 100
          itemTypes: [READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, HEAD_REF_FORCE_PUSHED_EVENT,
                      REVIEW_REQUESTED_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT]
        ) {
          nodes {
            __typename
            ... on ReadyForReviewEvent { createdAt actor { login __typename ... on User { id } } }
            ... on ConvertToDraftEvent { createdAt actor { login __typename ... on User { id } } }
            ... on HeadRefForcePushedEvent { createdAt actor { login __typename ... on User { id } } }
            ... on ReviewRequestedEvent { createdAt actor { login __typename ... on User { id } } }
            ... on MergedEvent { createdAt actor { login __typename ... on User { id } } }
            ... on ClosedEvent { createdAt actor { login __typename ... on User { id } } }
            ... on ReopenedEvent { createdAt actor { login __typename ... on User { id } } }
          }
        }`;

function pagedQuery(operation: string, orderByField: 'UPDATED_AT' | 'CREATED_AT'): string {
  return `
query ${operation}($owner: String!, $name: String!, $first: Int!, $after: String) {
  rateLimit { remaining resetAt cost }
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, after: $after, orderBy: {field: ${orderByField}, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {${PULL_REQUEST_NODE_SELECTION}
      }
    }
  }
}`;
}

/** The one query backfill uses. Page sizes are deliberately modest: cost scales with nesting. */
export const PULL_REQUESTS_QUERY = pagedQuery('PullRequests', 'UPDATED_AT');

/**
 * The history walk's query (design.md D2). `created_at` is immutable, so the ordering is stable
 * across pages and a resumed cursor cannot skip a pull request that shifted position mid-walk —
 * which `UPDATED_AT` cannot promise over a walk of thousands of pages.
 */
export const PULL_REQUESTS_BY_CREATION_QUERY = pagedQuery('PullRequestsByCreation', 'CREATED_AT');

/** Remaining file pages for one pull request, when its list did not fit in the bulk query. */
export const PULL_REQUEST_FILES_QUERY = `
query PullRequestFiles($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String) {
  rateLimit { remaining resetAt cost }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: $first, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { path additions deletions changeType }
      }
    }
  }
}`;

/**
 * Review comments for one pull request, from both places GitHub keeps them: attached to a review
 * submission, and on a diff thread. The two overlap — a diff comment belongs to an implicit
 * review — and are deduplicated by node id at persistence.
 */
export const PULL_REQUEST_REVIEW_COMMENTS_QUERY = `
query PullRequestReviewComments($owner: String!, $name: String!, $number: Int!) {
  rateLimit { remaining resetAt cost }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100) {
        nodes {
          id
          comments(first: 100) {
            nodes {
              id createdAt
              author { __typename login ... on User { id databaseId name avatarUrl } ... on Bot { id databaseId avatarUrl } }
            }
          }
        }
      }
      reviewThreads(first: 100) {
        nodes {
          comments(first: 100) {
            nodes {
              id createdAt
              pullRequestReview { id }
              author { __typename login ... on User { id databaseId name avatarUrl } ... on Bot { id databaseId avatarUrl } }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Default-branch commits over a window (design.md D5). One paged query per repository per window,
 * rather than one per pull request, which is what makes commit activity affordable as its own
 * series.
 */
export const DEFAULT_BRANCH_COMMITS_QUERY = `
query DefaultBranchCommits($owner: String!, $name: String!, $since: GitTimestamp!, $until: GitTimestamp!, $first: Int!, $after: String) {
  rateLimit { remaining resetAt cost }
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      name
      target {
        ... on Commit {
          history(since: $since, until: $until, first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id oid messageHeadline additions deletions changedFilesIfAvailable committedDate
              author { user { __typename login ... on User { id databaseId name avatarUrl } } }
            }
          }
        }
      }
    }
  }
}`;

export interface FilePage {
  nodes: GraphQLFileNode[];
  totalCount: number | null;
  endCursor: string | null;
  hasNextPage: boolean;
}

export interface GraphQLHistoryCommitNode {
  id: string;
  oid: string;
  messageHeadline: string | null;
  additions: number | null;
  deletions: number | null;
  changedFilesIfAvailable: number | null;
  committedDate: string;
  author: { user: GraphQLActor | null } | null;
}

export interface CommitHistoryPage {
  nodes: GraphQLHistoryCommitNode[];
  defaultBranch: string | null;
  endCursor: string | null;
  hasNextPage: boolean;
}

interface GraphQLEnvelope<T> {
  data?: T;
  errors?: { type?: string; message: string }[];
}

export class GitHubGraphQLClient {
  constructor(private readonly options: GraphQLClientOptions) {}

  async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await githubRequest<GraphQLEnvelope<T>>({
      method: 'POST',
      url: this.options.graphqlUrl,
      token: await this.options.token(),
      body: { query, variables },
      fetchImpl: this.options.fetchImpl,
      onRateLimit: this.options.onRateLimit,
    });

    const errors = response.data?.errors;
    if (errors && errors.length > 0) {
      // GraphQL reports rate limiting in the body with a 200 status.
      if (errors.some((error) => error.type === 'RATE_LIMITED')) {
        throw new RetryableError(`GitHub GraphQL rate limited: ${errors[0]!.message}`, 60);
      }
      if (errors.some((error) => error.type === 'NOT_FOUND' || error.type === 'FORBIDDEN')) {
        throw new PermanentError(`GitHub GraphQL rejected the query: ${errors[0]!.message}`);
      }
      throw new Error(`GitHub GraphQL error: ${errors.map((e) => e.message).join('; ')}`);
    }
    if (!response.data?.data) throw new Error('GitHub GraphQL returned no data');
    return response.data.data;
  }

  async fetchPullRequestPage(input: {
    owner: string;
    name: string;
    pageSize: number;
    after?: string | null;
  }): Promise<PullRequestPage> {
    return this.fetchPage(PULL_REQUESTS_QUERY, input);
  }

  /** The same page shape, ordered by creation date, for the history walk (design.md D2). */
  async fetchPullRequestPageByCreation(input: {
    owner: string;
    name: string;
    pageSize: number;
    after?: string | null;
  }): Promise<PullRequestPage> {
    return this.fetchPage(PULL_REQUESTS_BY_CREATION_QUERY, input);
  }

  /** One more page of a pull request's file list (spec: "pages until the file list is complete"). */
  async fetchPullRequestFiles(input: {
    owner: string;
    name: string;
    number: number;
    pageSize?: number;
    after?: string | null;
  }): Promise<FilePage> {
    const data = await this.query<{
      repository: { pullRequest: { files: GraphQLFileConnection | null } | null } | null;
    }>(PULL_REQUEST_FILES_QUERY, {
      owner: input.owner,
      name: input.name,
      number: input.number,
      first: input.pageSize ?? FILES_PAGE_SIZE,
      after: input.after ?? null,
    });

    const files = data.repository?.pullRequest?.files;
    if (!files) return { nodes: [], totalCount: null, endCursor: null, hasNextPage: false };
    return {
      nodes: files.nodes ?? [],
      totalCount: files.totalCount ?? null,
      endCursor: files.pageInfo.endCursor,
      hasNextPage: files.pageInfo.hasNextPage,
    };
  }

  /** Every review comment on one pull request, from review submissions and diff threads alike. */
  async fetchPullRequestReviewComments(input: {
    owner: string;
    name: string;
    number: number;
  }): Promise<Pick<GraphQLPullRequestNode, 'reviews' | 'reviewThreads'>> {
    const data = await this.query<{
      repository: {
        pullRequest: Pick<GraphQLPullRequestNode, 'reviews' | 'reviewThreads'> | null;
      } | null;
    }>(PULL_REQUEST_REVIEW_COMMENTS_QUERY, input);
    return data.repository?.pullRequest ?? { reviews: null, reviewThreads: null };
  }

  async fetchDefaultBranchCommits(input: {
    owner: string;
    name: string;
    since: Date;
    until: Date;
    pageSize: number;
    after?: string | null;
  }): Promise<CommitHistoryPage> {
    const data = await this.query<{
      repository: {
        defaultBranchRef: {
          name: string;
          target: {
            history?: {
              pageInfo: GraphQLPageInfo;
              nodes: GraphQLHistoryCommitNode[] | null;
            };
          } | null;
        } | null;
      } | null;
    }>(DEFAULT_BRANCH_COMMITS_QUERY, {
      owner: input.owner,
      name: input.name,
      since: input.since.toISOString(),
      until: input.until.toISOString(),
      first: input.pageSize,
      after: input.after ?? null,
    });

    if (!data.repository) {
      throw new PermanentError(`Repository ${input.owner}/${input.name} is not accessible`);
    }
    const ref = data.repository.defaultBranchRef;
    const history = ref?.target?.history;
    // An empty repository has no default branch ref at all; that is not an error.
    if (!history) {
      return {
        nodes: [],
        defaultBranch: ref?.name ?? null,
        endCursor: null,
        hasNextPage: false,
      };
    }
    return {
      nodes: history.nodes ?? [],
      defaultBranch: ref?.name ?? null,
      endCursor: history.pageInfo.endCursor,
      hasNextPage: history.pageInfo.hasNextPage,
    };
  }

  private async fetchPage(
    query: string,
    input: { owner: string; name: string; pageSize: number; after?: string | null },
  ): Promise<PullRequestPage> {
    const data = await this.query<{
      rateLimit?: { remaining: number; resetAt: string };
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: GraphQLPullRequestNode[];
        };
      } | null;
    }>(query, {
      owner: input.owner,
      name: input.name,
      first: input.pageSize,
      after: input.after ?? null,
    });

    if (!data.repository) {
      throw new PermanentError(`Repository ${input.owner}/${input.name} is not accessible`);
    }
    const page = data.repository.pullRequests;
    return {
      nodes: page.nodes ?? [],
      endCursor: page.pageInfo.endCursor,
      hasNextPage: page.pageInfo.hasNextPage,
      rateLimit: data.rateLimit,
    };
  }
}
