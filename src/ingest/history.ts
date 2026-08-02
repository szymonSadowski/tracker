/**
 * Member-requested history sync (spec: github-data-sync, design.md D2).
 *
 * Walks a repository's pull requests by creation date, newest first, extending coverage backwards
 * to a requested date or to the repository's first pull request. Chunked like backfill: bounded
 * pages per run, cursor and coverage recorded together after every page, re-enqueues itself while
 * work remains — so an interruption resumes at the last recorded page.
 *
 * Two things distinguish it from backfill. The ordering is `CREATED_AT`, which is immutable, so a
 * resumed cursor cannot skip a pull request that moved position mid-walk (D2). And it never
 * writes `synced_through`: how current a repository is belongs to incremental sync alone (R3).
 */
import type { Database } from '../db/driver';
import type { GitHubGraphQLClient } from '../github/graphql';
import type { RateLimitTracker } from '../github/rate-limit';
import { enqueue } from '../jobs/queue';
import {
  finishSyncRun,
  getRepository,
  listRepositories,
  markHistoryComplete,
  markHistoryFailed,
  markHistoryPaused,
  markHistorySyncStarted,
  recordHistoryProgress,
  startSyncRun,
  type HistoryState,
  type RepositoryRecord,
} from '../repositories/store';
import { mapGraphQLPullRequest } from './graphql-map';
import { persistPullRequest } from './normalize';

/** Default pages per job run; the worker passes the configured `HISTORY_PAGES_PER_RUN`. */
export const HISTORY_PAGES_PER_RUN = 5;
export const HISTORY_PAGE_SIZE = 25;

/** Priority below backfill's 50 and incremental's 10: current data is never starved (D5). */
export const HISTORY_JOB_PRIORITY = 100;

export const historyDedupeKey = (repositoryId: string) => `history:${repositoryId}`;

export interface HistoryDeps {
  graphql: GitHubGraphQLClient;
  rateLimit: RateLimitTracker;
  pagesPerRun?: number;
  now?: () => Date;
}

export interface HistoryOutcome {
  pullRequests: number;
  /** Nodes the walk passed over because coverage already proved them present. */
  skipped: number;
  pagesFetched: number;
  /** The requested range is fully ingested; nothing further is enqueued. */
  complete: boolean;
  /** The walk reached the repository's earliest pull request: no older history exists. */
  reachedEnd: boolean;
  /** The range was already covered, so no page was fetched at all. */
  alreadyCovered: boolean;
  coveredFrom: Date | null;
  cursor: string | null;
}

/**
 * Whether a repository already holds everything a request asks for. `from: null` asks for all
 * history, which only a completed walk can satisfy.
 */
export function coversRange(repository: RepositoryRecord, from: Date | null): boolean {
  if (repository.historyComplete) return true;
  if (from === null) return false;
  return repository.historyCoveredFrom !== null && repository.historyCoveredFrom <= from;
}

export async function runHistorySync(
  database: Database,
  input: { workspaceId: string; repositoryId: string; from: Date | null },
  deps: HistoryDeps,
): Promise<HistoryOutcome> {
  const now = deps.now?.() ?? new Date();
  const pagesPerRun = deps.pagesPerRun ?? HISTORY_PAGES_PER_RUN;
  const repository = await getRepository(database, input.repositoryId);
  if (!repository || repository.workspaceId !== input.workspaceId) {
    throw new Error(`Repository ${input.repositoryId} not found in workspace ${input.workspaceId}`);
  }

  const idle: HistoryOutcome = {
    pullRequests: 0,
    skipped: 0,
    pagesFetched: 0,
    complete: true,
    reachedEnd: repository.historyComplete,
    alreadyCovered: false,
    coveredFrom: repository.historyCoveredFrom,
    cursor: repository.historyCursor,
  };

  // Deselected while the job waited in the queue.
  if (!repository.inScope) return idle;

  // Already covered: no pages fetched, and the member is told so rather than shown a failure
  // (spec: "Requested range is already covered").
  if (coversRange(repository, input.from)) return { ...idle, alreadyCovered: true };

  await markHistorySyncStarted(database, repository.id, input.from);
  const syncRunId = await startSyncRun(database, {
    workspaceId: input.workspaceId,
    repositoryId: repository.id,
    kind: 'history',
    // The range asked for: from the requested date (null = the beginning) up to now.
    windowStart: input.from,
    windowEnd: now,
  });

  /**
   * What coverage proved present before this run started. Everything created at or after it is
   * already stored, so the walk pages over those nodes without rewriting them: the deepening pass
   * is strictly additive and leaves existing rows alone.
   */
  const alreadyPresentFrom = repository.historyCoveredFrom;

  let cursor = repository.historyCursor;
  let pullRequests = 0;
  let skipped = 0;
  let pagesFetched = 0;
  let coveredFrom = repository.historyCoveredFrom;
  let complete = false;
  let reachedEnd = false;
  let pausedForRateLimit = false;

  try {
    while (pagesFetched < pagesPerRun) {
      // Checked between pages, so a pause always lands with progress already recorded.
      if (deps.rateLimit.isBelowThreshold()) {
        pausedForRateLimit = true;
        break;
      }

      const page = await deps.graphql.fetchPullRequestPageByCreation({
        owner: repository.ownerLogin,
        name: repository.name,
        pageSize: HISTORY_PAGE_SIZE,
        after: cursor,
      });
      pagesFetched++;

      let reachedRequestedDate = false;
      let oldestOnPage: Date | null = null;
      for (const node of page.nodes) {
        const normalized = mapGraphQLPullRequest(node);
        if (input.from !== null && normalized.openedAt < input.from) {
          // Ordered by creation date descending: everything after this was created earlier still.
          reachedRequestedDate = true;
          break;
        }
        oldestOnPage = normalized.openedAt;
        if (alreadyPresentFrom !== null && normalized.openedAt >= alreadyPresentFrom) {
          skipped++;
          continue;
        }
        await database.transaction((tx) =>
          persistPullRequest(tx, {
            workspaceId: input.workspaceId,
            repositoryId: repository.id,
            pullRequest: normalized,
            source: 'graphql_history',
            rawPayload: node,
          }),
        );
        pullRequests++;
      }

      cursor = page.endCursor;
      if (reachedRequestedDate) {
        // Everything the member asked for is present. Claim exactly that and no more: the pull
        // request that stopped the walk was not stored.
        coveredFrom = earliest(coveredFrom, input.from);
        complete = true;
      } else if (!page.hasNextPage) {
        // The repository has no older pull requests, whether or not the requested date was
        // reached (spec: "Repository has no history older than its coverage").
        coveredFrom = earliest(coveredFrom, oldestOnPage);
        complete = true;
        reachedEnd = true;
      } else {
        coveredFrom = earliest(coveredFrom, oldestOnPage);
      }

      await recordHistoryProgress(database, repository.id, cursor, coveredFrom);
      if (complete) break;
    }

    if (complete) {
      await markHistoryComplete(database, repository.id, { reachedEnd, coveredFrom });
    } else if (pausedForRateLimit) {
      await markHistoryPaused(database, repository.id);
    }

    await finishSyncRun(database, syncRunId, {
      status: complete ? 'succeeded' : 'paused',
      pullRequestsSeen: pullRequests,
      cursor,
    });

    if (pausedForRateLimit) {
      // Throws a retryable error carrying the reset time; the worker turns it into a scheduled
      // retry, so the walk resumes without member action (spec: "History sync pauses for rate
      // limits").
      deps.rateLimit.assertHeadroom(`history sync of ${repository.fullName}`);
    }

    if (!complete) {
      // More pages remain: continue in a fresh job so other repositories get a turn.
      await enqueue(database, {
        workspaceId: input.workspaceId,
        type: 'repository.history_sync',
        payload: {
          repositoryId: repository.id,
          from: input.from === null ? null : input.from.toISOString(),
        },
        dedupeKey: historyDedupeKey(repository.id),
        priority: HISTORY_JOB_PRIORITY,
      });
    }

    return {
      pullRequests,
      skipped,
      pagesFetched,
      complete,
      reachedEnd,
      alreadyCovered: false,
      coveredFrom,
      cursor,
    };
  } catch (error) {
    // The pause path has already recorded its own state; it is not a failure.
    if (pausedForRateLimit) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await finishSyncRun(database, syncRunId, {
      status: 'failed',
      pullRequestsSeen: pullRequests,
      error: message,
      cursor,
    });
    await markHistoryFailed(database, repository.id, message);
    throw error;
  }
}

export type HistoryRequestStatus = 'enqueued' | 'already_covered' | 'already_running';

export interface HistoryRequestOutcome {
  repositoryId: string;
  fullName: string;
  status: HistoryRequestStatus;
  coveredFrom: Date | null;
  historyComplete: boolean;
  historyState: HistoryState;
}

/**
 * A workspace history request fans out to one job per in-scope repository (design.md D1), so each
 * repository reports its own progress and none waits behind the slowest.
 *
 * Accepted while other sync work is in flight: the dedupe key makes a repeat request for a
 * repository already walking a no-op rather than a failure, and priority 100 keeps incremental
 * sync ahead of it in the queue (D5).
 */
export async function requestHistorySync(
  database: Database,
  workspaceId: string,
  from: Date | null,
): Promise<{ enqueued: number; repositories: HistoryRequestOutcome[] }> {
  return database.transaction(async (tx) => {
    const repositories = await listRepositories(tx, workspaceId, { inScopeOnly: true });
    const outcomes: HistoryRequestOutcome[] = [];
    let enqueued = 0;

    for (const repository of repositories) {
      const state = {
        repositoryId: repository.id,
        fullName: repository.fullName,
        coveredFrom: repository.historyCoveredFrom,
        historyComplete: repository.historyComplete,
        historyState: repository.historyState,
      };
      if (coversRange(repository, from)) {
        outcomes.push({ ...state, status: 'already_covered' });
        continue;
      }
      const job = await enqueue(tx, {
        workspaceId,
        type: 'repository.history_sync',
        payload: { repositoryId: repository.id, from: from === null ? null : from.toISOString() },
        dedupeKey: historyDedupeKey(repository.id),
        priority: HISTORY_JOB_PRIORITY,
      });
      if (job) enqueued++;
      outcomes.push({ ...state, status: job ? 'enqueued' : 'already_running' });
    }

    return { enqueued, repositories: outcomes };
  });
}

/** Coverage only ever moves earlier: a run cannot un-cover what an earlier one proved. */
function earliest(current: Date | null, candidate: Date | null): Date | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return candidate < current ? candidate : current;
}
