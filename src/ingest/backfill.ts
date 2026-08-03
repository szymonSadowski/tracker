/**
 * Historical backfill (spec: github-data-sync).
 *
 * Chunked per repository: each run processes a bounded number of pages, records its cursor after
 * every page, and re-enqueues itself if there is more to do. An interruption — a crash, a rate
 * limit pause, a deploy — therefore resumes at the last recorded page rather than restarting the
 * repository.
 */
import type { Database, Queryable } from '../db/driver';
import type { GitHubGraphQLClient } from '../github/graphql';
import type { RateLimitTracker } from '../github/rate-limit';
import { enqueue } from '../jobs/queue';
import {
  finishSyncRun,
  getRepository,
  markBackfillComplete,
  markBackfillStarted,
  recordBackfillProgress,
  recordSyncFailure,
  recordSyncSuccess,
  startSyncRun,
  type RepositoryRecord,
} from '../repositories/store';
import { graphQLFilesPaging, mapGraphQLPullRequest } from './graphql-map';
import { completeFileList } from './files';
import { persistPullRequest } from './normalize';

/** Pages per job run. Bounded so one repository cannot monopolise a worker. */
export const PAGES_PER_RUN = 5;
export const PAGE_SIZE = 25;

export interface BackfillDeps {
  graphql: GitHubGraphQLClient;
  rateLimit: RateLimitTracker;
  backfillWindowDays: number;
  now?: () => Date;
}

export interface BackfillOutcome {
  pullRequests: number;
  pagesFetched: number;
  complete: boolean;
  cursor: string | null;
}

export function backfillWindowStart(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 24 * 3600_000);
}

export async function runBackfill(
  database: Database,
  input: { workspaceId: string; repositoryId: string },
  deps: BackfillDeps,
): Promise<BackfillOutcome> {
  const now = deps.now?.() ?? new Date();
  const repository = await getRepository(database, input.repositoryId);
  if (!repository || repository.workspaceId !== input.workspaceId) {
    throw new Error(`Repository ${input.repositoryId} not found in workspace ${input.workspaceId}`);
  }
  if (!repository.inScope) {
    // Deselected while the job waited in the queue.
    return { pullRequests: 0, pagesFetched: 0, complete: true, cursor: null };
  }

  const windowStart =
    repository.backfillWindowStart ?? backfillWindowStart(deps.backfillWindowDays, now);
  await markBackfillStarted(database, repository.id, windowStart);
  const syncRunId = await startSyncRun(database, {
    workspaceId: input.workspaceId,
    repositoryId: repository.id,
    kind: 'backfill',
    windowStart,
    windowEnd: now,
  });

  let cursor = repository.backfillCursor;
  let pullRequests = 0;
  let pagesFetched = 0;
  let complete = false;

  try {
    while (pagesFetched < PAGES_PER_RUN) {
      // Checked between pages, so a pause always happens with progress already recorded.
      deps.rateLimit.assertHeadroom(`backfill of ${repository.fullName}`);

      const page = await deps.graphql.fetchPullRequestPage({
        owner: repository.ownerLogin,
        name: repository.name,
        pageSize: PAGE_SIZE,
        after: cursor,
      });
      pagesFetched++;

      let reachedWindowEdge = false;
      for (const node of page.nodes) {
        const normalized = mapGraphQLPullRequest(node);
        if (normalized.githubUpdatedAt < windowStart) {
          // Ordered by updated-at descending: everything after this is older than the window.
          reachedWindowEdge = true;
          break;
        }

        // The file connection arrives inline for almost every pull request; the rare one with
        // more files than a page is completed here before it is persisted, so a partial list is
        // never written as though it were whole (spec: "pages until the file list is complete").
        const paging = graphQLFilesPaging(node);
        if (paging.hasNextPage) {
          const complete = await completeFileList(
            deps.graphql,
            { owner: repository.ownerLogin, name: repository.name, number: normalized.number },
            paging,
          );
          normalized.files = complete.files;
          normalized.filesTruncated = complete.truncated;
        }

        await database.transaction((tx) =>
          persistPullRequest(tx, {
            workspaceId: input.workspaceId,
            repositoryId: repository.id,
            pullRequest: normalized,
            source: 'graphql_backfill',
            rawPayload: node,
          }),
        );
        pullRequests++;
      }

      cursor = page.endCursor;
      await recordBackfillProgress(database, repository.id, cursor);

      if (reachedWindowEdge || !page.hasNextPage) {
        complete = true;
        break;
      }
    }

    if (complete) {
      await markBackfillComplete(database, repository.id);
      await recordSyncSuccess(database, repository.id, now);
    }
    await finishSyncRun(database, syncRunId, {
      status: complete ? 'succeeded' : 'paused',
      pullRequestsSeen: pullRequests,
      cursor,
    });

    if (!complete) {
      // More pages remain: continue in a fresh job so other repositories get a turn.
      await enqueue(database, {
        workspaceId: input.workspaceId,
        type: 'repository.backfill',
        payload: { repositoryId: repository.id },
        dedupeKey: `backfill:${repository.id}`,
        priority: 50,
      });
    } else {
      await scheduleFirstIncrementalSync(database, repository, now);
    }

    return { pullRequests, pagesFetched, complete, cursor };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishSyncRun(database, syncRunId, {
      status: 'failed',
      pullRequestsSeen: pullRequests,
      error: message,
      cursor,
    });
    await recordSyncFailure(database, repository.id, message);
    throw error;
  }
}

/** Cron sync begins for a repository once its backfill completes (design.md migration plan). */
async function scheduleFirstIncrementalSync(
  db: Queryable,
  repository: RepositoryRecord,
  now: Date,
): Promise<void> {
  await db.query(
    'UPDATE repositories SET synced_through = COALESCE(synced_through, $2) WHERE id = $1',
    [repository.id, now],
  );
}
