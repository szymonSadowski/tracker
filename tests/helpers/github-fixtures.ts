/**
 * One pull request expressed as both provider payloads, so the two ingestion paths can be checked
 * against each other (spec: github-data-sync "All ingestion paths produce identical normalized
 * records").
 */
import type { GraphQLPullRequestNode } from '../../src/github/graphql';
import type { RestPullRequestBundle } from '../../src/ingest/rest-map';

export const T0 = new Date('2026-04-01T09:00:00.000Z');
export const iso = (hoursFromT0: number) =>
  new Date(T0.getTime() + hoursFromT0 * 3600_000).toISOString();

const ada = { login: 'ada', nodeId: 'U_ada', databaseId: 11 };
const bob = { login: 'bob', nodeId: 'U_bob', databaseId: 22 };

export interface FixtureOptions {
  nodeId?: string;
  number?: number;
  mergedAtHours?: number | null;
  updatedAtHours?: number;
  /** Creation time relative to T0. Negative values are older, which the history walk orders by. */
  createdAtHours?: number;
  draft?: boolean;
  authorIsBot?: boolean;
}

export function graphqlPullRequest(options: FixtureOptions = {}): GraphQLPullRequestNode {
  const merged = options.mergedAtHours === undefined ? 8 : options.mergedAtHours;
  // GitHub node ids are globally unique, so the fixture derives nested ids from the pull
  // request's own id rather than reusing one id across pull requests.
  const prNodeId = options.nodeId ?? 'PR_1';
  const author = options.authorIsBot
    ? { __typename: 'Bot', login: 'dependabot', id: 'U_bot', databaseId: 99 }
    : {
        __typename: 'User',
        login: ada.login,
        id: ada.nodeId,
        databaseId: ada.databaseId,
        name: 'Ada',
      };

  return {
    id: options.nodeId ?? 'PR_1',
    number: options.number ?? 7,
    title: 'Add rate limiting',
    url: 'https://github.com/acme/api/pull/7',
    isDraft: options.draft ?? false,
    createdAt: iso(options.createdAtHours ?? 0),
    updatedAt: iso(options.updatedAtHours ?? merged ?? 8),
    closedAt: merged === null ? null : iso(merged),
    mergedAt: merged === null ? null : iso(merged),
    additions: 120,
    deletions: 30,
    changedFiles: 5,
    baseRefName: 'main',
    headRefName: 'feat/rate-limit',
    author,
    reviews: {
      nodes: [
        {
          id: `PRR_${prNodeId}`,
          state: 'APPROVED',
          submittedAt: iso(4),
          bodyText: 'looks good',
          author: {
            __typename: 'User',
            login: bob.login,
            id: bob.nodeId,
            databaseId: bob.databaseId,
          },
        },
      ],
    },
    commits: {
      nodes: [
        {
          commit: {
            id: `C_${prNodeId}`,
            oid: `sha_${prNodeId}`,
            messageHeadline: 'Add limiter',
            additions: 100,
            deletions: 20,
            changedFilesIfAvailable: null,
            committedDate: iso(1),
            authoredDate: iso(1),
            author: {
              user: {
                __typename: 'User',
                login: ada.login,
                id: ada.nodeId,
                databaseId: ada.databaseId,
              },
            },
          },
        },
      ],
    },
    timelineItems: {
      nodes: [
        {
          __typename: 'ReadyForReviewEvent',
          createdAt: iso(2),
          actor: { __typename: 'User', login: ada.login, id: ada.nodeId },
        },
      ],
    },
  };
}

export function restPullRequest(options: FixtureOptions = {}): RestPullRequestBundle {
  const merged = options.mergedAtHours === undefined ? 8 : options.mergedAtHours;
  const prNodeId = options.nodeId ?? 'PR_1';
  const author = options.authorIsBot
    ? { id: 99, node_id: 'U_bot', login: 'dependabot', type: 'Bot' }
    : { id: ada.databaseId, node_id: ada.nodeId, login: ada.login, type: 'User', name: 'Ada' };

  return {
    pullRequest: {
      id: 700,
      node_id: options.nodeId ?? 'PR_1',
      number: options.number ?? 7,
      title: 'Add rate limiting',
      state: merged === null ? 'open' : 'closed',
      draft: options.draft ?? false,
      html_url: 'https://github.com/acme/api/pull/7',
      user: author,
      created_at: iso(0),
      updated_at: iso(options.updatedAtHours ?? merged ?? 8),
      closed_at: merged === null ? null : iso(merged),
      merged_at: merged === null ? null : iso(merged),
      additions: 120,
      deletions: 30,
      changed_files: 5,
      base: { ref: 'main' },
      head: { ref: 'feat/rate-limit' },
    },
    reviews: [
      {
        id: 1,
        node_id: `PRR_${prNodeId}`,
        user: { id: bob.databaseId, node_id: bob.nodeId, login: bob.login, type: 'User' },
        state: 'APPROVED',
        body: 'looks good',
        submitted_at: iso(4),
      },
    ],
    commits: [
      {
        sha: `sha_${prNodeId}`,
        node_id: `C_${prNodeId}`,
        commit: {
          message: 'Add limiter\n\nDetails follow.',
          author: { date: iso(1) },
          committer: { date: iso(1) },
        },
        author: { id: ada.databaseId, node_id: ada.nodeId, login: ada.login, type: 'User' },
        stats: { additions: 100, deletions: 20 },
      },
    ],
    timeline: [
      {
        event: 'ready_for_review',
        created_at: iso(2),
        actor: { id: ada.databaseId, node_id: ada.nodeId, login: ada.login, type: 'User' },
      },
      {
        event: 'committed',
        sha: `sha_${prNodeId}`,
        author: { date: iso(1) },
        committer: { date: iso(1) },
      },
    ],
  };
}
