/**
 * The two paged pull request queries. They exist to be ordered differently and otherwise be the
 * same query: the history walk normalizes through `mapGraphQLPullRequest` exactly as backfill
 * does (design.md D2), so any divergence in what they select is a bug this file catches.
 */
import { describe, expect, it } from 'vitest';
import {
  GitHubGraphQLClient,
  PULL_REQUESTS_BY_CREATION_QUERY,
  PULL_REQUESTS_QUERY,
} from '../../src/github/graphql';
import { graphqlPullRequest } from '../helpers/github-fixtures';
import { mapGraphQLPullRequest } from '../../src/ingest/graphql-map';

interface Captured {
  query: string;
  variables: Record<string, unknown>;
}

/** A GraphQL endpoint that records what it was asked and replies with the fixture page. */
function fakeGitHub(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
) {
  const calls: Captured[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body) as Captured);
    return new Response(
      JSON.stringify({
        data: {
          rateLimit: { remaining: 4900, resetAt: '2026-04-01T10:00:00Z', cost: 1 },
          repository: { pullRequests: { pageInfo, nodes } },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

  const client = new GitHubGraphQLClient({
    graphqlUrl: 'https://api.github.com/graphql',
    token: () => 'token',
    fetchImpl,
  });
  return { client, calls };
}

describe('paged pull request queries', () => {
  it('orders the history query by creation date and the backfill query by update date', () => {
    expect(PULL_REQUESTS_BY_CREATION_QUERY).toContain(
      'orderBy: {field: CREATED_AT, direction: DESC}',
    );
    expect(PULL_REQUESTS_QUERY).toContain('orderBy: {field: UPDATED_AT, direction: DESC}');
  });

  it('selects the same fields in both, so normalization cannot drift between the paths', () => {
    const fields = (query: string) =>
      query.replace(/query \w+/, 'query').replace(/field: \w+/, 'field: ORDER');
    expect(fields(PULL_REQUESTS_BY_CREATION_QUERY)).toEqual(fields(PULL_REQUESTS_QUERY));
  });

  it('returns the same page shape from the created-at query', async () => {
    const node = graphqlPullRequest({ nodeId: 'PR_hist', number: 3 });
    const { client, calls } = fakeGitHub([node], { hasNextPage: true, endCursor: 'cursor-1' });

    const page = await client.fetchPullRequestPageByCreation({
      owner: 'acme',
      name: 'api',
      pageSize: 25,
      after: 'cursor-0',
    });

    expect(calls[0]!.query).toEqual(PULL_REQUESTS_BY_CREATION_QUERY);
    expect(calls[0]!.variables).toEqual({
      owner: 'acme',
      name: 'api',
      first: 25,
      after: 'cursor-0',
    });
    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBe('cursor-1');
    expect(page.rateLimit?.remaining).toBe(4900);
    expect(page.nodes).toHaveLength(1);
  });

  it('normalizes a fixture node identically whichever query fetched it', async () => {
    const node = graphqlPullRequest({ nodeId: 'PR_same', number: 9 });
    const byUpdate = fakeGitHub([node], { hasNextPage: false, endCursor: null });
    const byCreation = fakeGitHub([node], { hasNextPage: false, endCursor: null });
    const input = { owner: 'acme', name: 'api', pageSize: 25 };

    const backfilled = await byUpdate.client.fetchPullRequestPage(input);
    const walked = await byCreation.client.fetchPullRequestPageByCreation(input);

    expect(mapGraphQLPullRequest(walked.nodes[0]!)).toEqual(
      mapGraphQLPullRequest(backfilled.nodes[0]!),
    );
  });
});
