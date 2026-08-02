/**
 * Rebuild normalized records from retained raw payloads (spec: github-data-sync "Raw payloads are
 * retained for reprocessing"). Makes no GitHub requests: a normalization fix is a batch job, not
 * a re-backfill.
 */
import type { Database, Queryable } from '../db/driver';
import { mapGraphQLPullRequest } from './graphql-map';
import { mapRestPullRequest, type RestPullRequestBundle } from './rest-map';
import type { GraphQLPullRequestNode } from '../github/graphql';
import type { NormalizedPullRequest } from './model';
import { persistPullRequest, type IngestSource } from './normalize';

interface RawRow {
  entity_node_id: string;
  repository_id: string | null;
  source: IngestSource;
  payload: unknown;
}

export function mapRawPayload(source: IngestSource, payload: unknown): NormalizedPullRequest {
  if (source === 'graphql_backfill') {
    return mapGraphQLPullRequest(payload as GraphQLPullRequestNode);
  }
  return mapRestPullRequest(payload as RestPullRequestBundle);
}

/** The most recent payload retained for each pull request in scope. */
export async function latestRawPayloads(
  db: Queryable,
  workspaceId: string,
  repositoryId?: string,
): Promise<RawRow[]> {
  const { rows } = await db.query<RawRow>(
    `SELECT DISTINCT ON (entity_node_id) entity_node_id, repository_id, source, payload
       FROM github_raw_events
      WHERE workspace_id = $1
        AND entity_type = 'pull_request'
        AND ($2::uuid IS NULL OR repository_id = $2)
      ORDER BY entity_node_id, fetched_at DESC`,
    [workspaceId, repositoryId ?? null],
  );
  return rows.map((row) => ({
    ...row,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
  }));
}

export interface ReprocessOutcome {
  pullRequests: number;
  skipped: number;
}

export async function reprocessFromRaw(
  database: Database,
  input: { workspaceId: string; repositoryId?: string },
): Promise<ReprocessOutcome> {
  const rows = await latestRawPayloads(database, input.workspaceId, input.repositoryId);
  let pullRequests = 0;
  let skipped = 0;

  for (const row of rows) {
    if (!row.repository_id) {
      skipped++;
      continue;
    }
    const normalized = mapRawPayload(row.source, row.payload);
    await database.transaction((tx) =>
      persistPullRequest(tx, {
        workspaceId: input.workspaceId,
        repositoryId: row.repository_id!,
        pullRequest: normalized,
        source: row.source,
        // The payload came *from* raw storage; writing it back would be a second copy.
        storeRaw: false,
      }),
    );
    pullRequests++;
  }

  return { pullRequests, skipped };
}
