/**
 * Incremental sync (spec: github-data-sync, design.md D3).
 *
 * Polls REST for pull requests updated since the last successful sync, minus an overlap, so no
 * change can fall between two windows. Re-ingesting the overlap is safe by construction: every
 * write is an upsert keyed by node id (D4).
 */
import type { Database } from '../db/driver';
import type { GitHubRestClient } from '../github/rest';
import type { RateLimitTracker } from '../github/rate-limit';
import { enqueue } from '../jobs/queue';
import {
  finishSyncRun,
  getRepository,
  listRepositories,
  recordSyncFailure,
  recordSyncSuccess,
  startSyncRun,
} from '../repositories/store';
import { mapRestPullRequest } from './rest-map';
import { persistPullRequest } from './normalize';

export const MAX_PAGES_PER_SYNC = 10;
export const SYNC_PAGE_SIZE = 50;

export interface IncrementalDeps {
  rest: GitHubRestClient;
  rateLimit: RateLimitTracker;
  overlapMinutes: number;
  now?: () => Date;
}

export interface IncrementalOutcome {
  pullRequests: number;
  windowStart: Date;
  syncedThrough: Date;
}

export async function runIncrementalSync(
  database: Database,
  input: { workspaceId: string; repositoryId: string },
  deps: IncrementalDeps,
): Promise<IncrementalOutcome> {
  const now = deps.now?.() ?? new Date();
  const repository = await getRepository(database, input.repositoryId);
  if (!repository || repository.workspaceId !== input.workspaceId) {
    throw new Error(`Repository ${input.repositoryId} not found in workspace ${input.workspaceId}`);
  }
  if (!repository.inScope) {
    return { pullRequests: 0, windowStart: now, syncedThrough: now };
  }

  const overlapMs = deps.overlapMinutes * 60_000;
  const windowStart = repository.syncedThrough
    ? new Date(repository.syncedThrough.getTime() - overlapMs)
    : new Date(now.getTime() - 24 * 3600_000);

  const syncRunId = await startSyncRun(database, {
    workspaceId: input.workspaceId,
    repositoryId: repository.id,
    kind: 'incremental',
    windowStart,
    windowEnd: now,
  });

  let pullRequests = 0;
  try {
    for (let page = 1; page <= MAX_PAGES_PER_SYNC; page++) {
      deps.rateLimit.assertHeadroom(`sync of ${repository.fullName}`);
      const listed = await deps.rest.listPullRequestsPage(
        repository.ownerLogin,
        repository.name,
        page,
        SYNC_PAGE_SIZE,
      );
      if (listed.length === 0) break;

      let passedWindow = false;
      for (const summary of listed) {
        if (new Date(summary.updated_at) < windowStart) {
          // Ordered by most recently updated: the rest of this page is older still.
          passedWindow = true;
          break;
        }
        // The list endpoint omits diff statistics, so the detail view is fetched per pull request.
        const [detail, reviews, commits, timeline] = await Promise.all([
          deps.rest.getPullRequest(repository.ownerLogin, repository.name, summary.number),
          deps.rest.listReviews(repository.ownerLogin, repository.name, summary.number),
          deps.rest.listCommits(repository.ownerLogin, repository.name, summary.number),
          deps.rest.listTimeline(repository.ownerLogin, repository.name, summary.number),
        ]);

        const normalized = mapRestPullRequest({
          pullRequest: detail,
          reviews,
          commits,
          timeline,
        });
        await database.transaction((tx) =>
          persistPullRequest(tx, {
            workspaceId: input.workspaceId,
            repositoryId: repository.id,
            pullRequest: normalized,
            source: 'rest_incremental',
            rawPayload: { pullRequest: detail, reviews, commits, timeline },
          }),
        );
        pullRequests++;
      }
      if (passedWindow || listed.length < SYNC_PAGE_SIZE) break;
    }

    await recordSyncSuccess(database, repository.id, now);
    await finishSyncRun(database, syncRunId, {
      status: 'succeeded',
      pullRequestsSeen: pullRequests,
    });
    return { pullRequests, windowStart, syncedThrough: now };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishSyncRun(database, syncRunId, {
      status: 'failed',
      pullRequestsSeen: pullRequests,
      error: message,
    });
    await recordSyncFailure(database, repository.id, message);
    throw error;
  }
}

/**
 * Fan out the workspace's periodic sync: one job per in-scope repository whose backfill has
 * finished. Repositories still backfilling are left to their backfill job.
 */
export async function enqueueWorkspaceSyncs(
  database: Database,
  workspaceId: string,
): Promise<number> {
  return database.transaction(async (tx) => {
    const repositories = await listRepositories(tx, workspaceId, { inScopeOnly: true });
    let enqueued = 0;
    for (const repository of repositories) {
      if (repository.backfillState !== 'complete') continue;
      const job = await enqueue(tx, {
        workspaceId,
        type: 'repository.incremental_sync',
        payload: { repositoryId: repository.id, reason: 'schedule' },
        dedupeKey: `sync:${repository.id}`,
      });
      if (job) enqueued++;
    }
    return enqueued;
  });
}

export interface OnDemandSyncOutcome {
  enqueued: number;
  debounced: boolean;
  /**
   * Repositories left to their backfill job. Reported so a zero-enqueued result can be explained
   * rather than looking like a dead button (spec: "Member triggers a sync during backfill").
   */
  backfilling: { id: string; fullName: string }[];
}

/**
 * On-demand sync (spec: "Members can trigger a sync on demand"). Debounced per workspace: a
 * request inside the debounce window is accepted but enqueues nothing new.
 */
export async function requestOnDemandSync(
  database: Database,
  workspaceId: string,
  debounceSeconds: number,
): Promise<OnDemandSyncOutcome> {
  return database.transaction(async (tx) => {
    const repositories = await listRepositories(tx, workspaceId, { inScopeOnly: true });
    const backfilling = repositories
      .filter((repository) => repository.backfillState !== 'complete')
      .map((repository) => ({ id: repository.id, fullName: repository.fullName }));

    const { rows } = await tx.query<{ recent: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM jobs
          WHERE workspace_id = $1
            AND type = 'repository.incremental_sync'
            AND payload->>'reason' = 'on_demand'
            AND created_at > now() - make_interval(secs => $2::double precision)
       ) AS recent`,
      [workspaceId, debounceSeconds],
    );
    if (rows[0]!.recent) return { enqueued: 0, debounced: true, backfilling };

    let enqueued = 0;
    for (const repository of repositories) {
      if (repository.backfillState !== 'complete') continue;
      const job = await enqueue(tx, {
        workspaceId,
        type: 'repository.incremental_sync',
        payload: { repositoryId: repository.id, reason: 'on_demand' },
        dedupeKey: `sync:${repository.id}`,
        priority: 10,
      });
      if (job) enqueued++;
    }
    return { enqueued, debounced: false, backfilling };
  });
}
