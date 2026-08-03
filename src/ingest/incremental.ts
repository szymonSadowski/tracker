/**
 * Incremental sync (spec: github-data-sync, design.md D3).
 *
 * Polls REST for pull requests updated since the last successful sync, minus an overlap, so no
 * change can fall between two windows. Re-ingesting the overlap is safe by construction: every
 * write is an upsert keyed by node id (D4).
 */
import type { Database } from '../db/driver';
import type {
  GitHubRestClient,
  RestCommit,
  RestCommitDetail,
  RestPullRequest,
} from '../github/rest';
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

/**
 * How many commits per pull request the incremental path will fetch statistics for. Bounded so a
 * pull request with a long branch cannot dominate a sync window.
 */
export const COMMIT_DETAILS_PER_PULL_REQUEST = 20;

async function fetchCommitFileDetails(
  deps: IncrementalDeps,
  repository: { ownerLogin: string; name: string },
  detail: RestPullRequest,
  commits: readonly RestCommit[],
): Promise<RestCommitDetail[]> {
  const anchor = detail.created_at ? new Date(detail.created_at) : null;
  const relevant = commits
    .filter((commit) => {
      const date = commit.commit.committer?.date ?? commit.commit.author?.date;
      return date !== undefined && (anchor === null || new Date(date) >= anchor);
    })
    .slice(-COMMIT_DETAILS_PER_PULL_REQUEST);

  const details: RestCommitDetail[] = [];
  for (const commit of relevant) {
    details.push(await deps.rest.getCommit(repository.ownerLogin, repository.name, commit.sha));
  }
  return details;
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
        // Files and review comments come with it, so this path produces the same normalized
        // records the GraphQL one does (spec: "All ingestion paths produce identical records").
        const [detail, reviews, commits, timeline, files, reviewComments] = await Promise.all([
          deps.rest.getPullRequest(repository.ownerLogin, repository.name, summary.number),
          deps.rest.listReviews(repository.ownerLogin, repository.name, summary.number),
          deps.rest.listCommits(repository.ownerLogin, repository.name, summary.number),
          deps.rest.listTimeline(repository.ownerLogin, repository.name, summary.number),
          deps.rest.listPullRequestFiles(repository.ownerLogin, repository.name, summary.number),
          deps.rest.listReviewComments(repository.ownerLogin, repository.name, summary.number),
        ]);

        // Per-commit statistics cost one request each, so only the commits a metric is defined
        // over are fetched: those from the ready-for-review anchor onwards, which is what PR
        // maturity and the post-review rework component read.
        const commitFiles = await fetchCommitFileDetails(deps, repository, detail, commits);

        const normalized = mapRestPullRequest({
          pullRequest: detail,
          reviews,
          commits,
          timeline,
          files,
          reviewComments,
          commitFiles,
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
 * On-demand sync (spec: "Members can trigger a sync on demand"). Debounced: a request inside the
 * debounce window is accepted but enqueues nothing new.
 *
 * `repositoryId` narrows the request to one repository, which is what the pull request list offers
 * when it is filtered to a single one. The debounce narrows with it — a workspace-wide sync a
 * moment ago should not silence a request for one repository, and vice versa — so the window is
 * measured against requests for the same target.
 */
export async function requestOnDemandSync(
  database: Database,
  workspaceId: string,
  debounceSeconds: number,
  options: { repositoryId?: string } = {},
): Promise<OnDemandSyncOutcome> {
  return database.transaction(async (tx) => {
    const all = await listRepositories(tx, workspaceId, { inScopeOnly: true });
    const repositories = options.repositoryId
      ? all.filter((repository) => repository.id === options.repositoryId)
      : all;
    const backfilling = repositories
      .filter((repository) => repository.backfillState !== 'complete')
      .map((repository) => ({ id: repository.id, fullName: repository.fullName }));

    const { rows } = await tx.query<{ recent: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM jobs
          WHERE workspace_id = $1
            AND type = 'repository.incremental_sync'
            AND payload->>'reason' = 'on_demand'
            AND ($3::text IS NULL OR payload->>'repositoryId' = $3::text)
            AND created_at > now() - make_interval(secs => $2::double precision)
       ) AS recent`,
      [workspaceId, debounceSeconds, options.repositoryId ?? null],
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
