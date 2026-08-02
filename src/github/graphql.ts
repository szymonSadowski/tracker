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

export interface GraphQLPullRequestNode {
  id: string;
  number: number;
  title: string;
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
  reviews: {
    nodes: {
      id: string;
      state: string;
      submittedAt: string | null;
      bodyText?: string | null;
      author: GraphQLActor | null;
    }[];
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
 * The node selection both paged queries share, so the two paths normalize identically and a
 * change to what is fetched cannot drift between them.
 */
const PULL_REQUEST_NODE_SELECTION = `
        id number title url isDraft createdAt updatedAt closedAt mergedAt
        additions deletions changedFiles baseRefName headRefName
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
