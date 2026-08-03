/**
 * File-level fill-in for already-ingested history (spec: github-data-sync "File-level data is
 * backfilled progressively", design.md D5).
 *
 * Pull requests ingested before file data was collected keep their latency and size metrics and
 * simply lack churn. This pass fills that gap in the background: bounded per run, resumable by
 * construction — `files_ingested_at` is a monotone marker, so an interrupted run resumes at the
 * pull requests it never reached rather than restarting — and ranked below incremental sync so a
 * repository's fresh data is never delayed by its history.
 */
import type { Database } from '../db/driver';
import type { GitHubGraphQLClient } from '../github/graphql';
import type { GitHubRestClient } from '../github/rest';
import type { RateLimitTracker } from '../github/rate-limit';
import { RetryableError } from '../jobs/errors';
import { enqueue } from '../jobs/queue';
import {
  finishSyncRun,
  getRepository,
  listRepositories,
  startSyncRun,
} from '../repositories/store';
import { mapGraphQLReviewComments } from './graphql-map';
import { completeFileList } from './files';
import { mapRestCommitFiles } from './rest-map';
import { persistPullRequestFileData } from './normalize';
import type { NormalizedCommitFiles } from './model';

/** Pull requests filled per run. Bounded so the pass yields the worker frequently. */
export const FILL_IN_BATCH_SIZE = 20;

/**
 * Per-commit statistics are fetched one REST request per commit, so the pass limits itself to the
 * commits that can change a metric: those on or after the ready-for-review anchor, which are the
 * ones PR maturity and post-review rework are defined over.
 */
export const FILL_IN_COMMITS_PER_PULL_REQUEST = 20;

/** Below incremental sync (100) in the queue's ascending priority, above classification. */
export const FILL_IN_JOB_PRIORITY = 150;

export interface FileFillInDeps {
  graphql: GitHubGraphQLClient;
  rest: GitHubRestClient;
  rateLimit: RateLimitTracker;
}

export interface FileFillInOutcome {
  pullRequests: number;
  complete: boolean;
  paused: boolean;
  pauseReason: string | null;
}

interface PendingRow {
  id: string;
  number: number;
  opened_at: Date;
  ready_for_review_at: Date | null;
}

async function fetchCommitFiles(
  rest: GitHubRestClient,
  database: Database,
  input: { owner: string; name: string; pullRequestId: string; since: Date | null },
): Promise<NormalizedCommitFiles[]> {
  const { rows } = await database.query<{ oid: string | null }>(
    `SELECT oid FROM pr_commits
      WHERE pull_request_id = $1 AND oid IS NOT NULL
        AND ($2::timestamptz IS NULL OR committed_at >= $2)
      ORDER BY committed_at
      LIMIT ${FILL_IN_COMMITS_PER_PULL_REQUEST}`,
    [input.pullRequestId, input.since],
  );

  const collected: NormalizedCommitFiles[] = [];
  for (const row of rows) {
    if (!row.oid) continue;
    const detail = await rest.getCommit(input.owner, input.name, row.oid);
    const mapped = mapRestCommitFiles(detail);
    if (mapped) collected.push(mapped);
  }
  return collected;
}

export async function runFileFillIn(
  database: Database,
  input: { workspaceId: string; repositoryId: string },
  deps: FileFillInDeps,
): Promise<FileFillInOutcome> {
  const repository = await getRepository(database, input.repositoryId);
  if (!repository || repository.workspaceId !== input.workspaceId) {
    throw new Error(`Repository ${input.repositoryId} not found in workspace ${input.workspaceId}`);
  }
  if (!repository.inScope) {
    return { pullRequests: 0, complete: true, paused: false, pauseReason: null };
  }

  const { rows: pending } = await database.query<PendingRow>(
    `SELECT id, number, opened_at, ready_for_review_at
       FROM pull_requests
      WHERE workspace_id = $1 AND repository_id = $2 AND files_ingested_at IS NULL
      ORDER BY COALESCE(merged_at, opened_at) DESC
      LIMIT ${FILL_IN_BATCH_SIZE}`,
    [input.workspaceId, repository.id],
  );

  if (pending.length === 0) {
    return { pullRequests: 0, complete: true, paused: false, pauseReason: null };
  }

  const syncRunId = await startSyncRun(database, {
    workspaceId: input.workspaceId,
    repositoryId: repository.id,
    kind: 'file_fill_in',
  });

  let filled = 0;
  let pauseReason: string | null = null;

  try {
    for (const row of pending) {
      try {
        deps.rateLimit.assertHeadroom(`file fill-in of ${repository.fullName}`);
      } catch (error) {
        // A pause is not a failure: progress already made stays recorded and the pass resumes.
        if (!(error instanceof RetryableError)) throw error;
        pauseReason = error.message;
        break;
      }

      const target = { owner: repository.ownerLogin, name: repository.name, number: row.number };
      const { files, truncated } = await completeFileList(deps.graphql, target);
      const commentSource = await deps.graphql.fetchPullRequestReviewComments(target);
      const reviewComments = mapGraphQLReviewComments(commentSource) ?? [];
      const commitFiles = await fetchCommitFiles(deps.rest, database, {
        owner: repository.ownerLogin,
        name: repository.name,
        pullRequestId: row.id,
        since: row.ready_for_review_at,
      });

      await database.transaction((tx) =>
        persistPullRequestFileData(tx, {
          workspaceId: input.workspaceId,
          repositoryId: repository.id,
          pullRequestId: row.id,
          openedAt: row.opened_at,
          files,
          filesTruncated: truncated,
          reviewComments,
          reviewCommentsComplete: true,
          commitFiles,
          // The pull request was analyzed without churn; it gains it now.
          enqueueAnalysis: true,
        }),
      );
      filled++;
    }

    const { rows: remaining } = await database.query<{ remaining: number }>(
      `SELECT count(*)::int AS remaining
         FROM pull_requests
        WHERE workspace_id = $1 AND repository_id = $2 AND files_ingested_at IS NULL`,
      [input.workspaceId, repository.id],
    );
    const complete = pauseReason === null && remaining[0]!.remaining === 0;

    await finishSyncRun(database, syncRunId, {
      status: complete ? 'succeeded' : 'paused',
      pullRequestsSeen: filled,
      pauseReason,
    });

    if (!complete) {
      await enqueue(database, {
        workspaceId: input.workspaceId,
        type: 'repository.file_fill_in',
        payload: { repositoryId: repository.id },
        dedupeKey: `file_fill_in:${repository.id}`,
        priority: FILL_IN_JOB_PRIORITY,
      });
    }

    return { pullRequests: filled, complete, paused: pauseReason !== null, pauseReason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishSyncRun(database, syncRunId, {
      status: 'failed',
      pullRequestsSeen: filled,
      error: message,
    });
    throw error;
  }
}

/** One fill-in job per in-scope repository that still has pull requests lacking file data. */
export async function enqueueWorkspaceFileFillIn(
  database: Database,
  workspaceId: string,
): Promise<number> {
  return database.transaction(async (tx) => {
    const repositories = await listRepositories(tx, workspaceId, { inScopeOnly: true });
    let enqueued = 0;
    for (const repository of repositories) {
      const { rows } = await tx.query<{ pending: number }>(
        `SELECT count(*)::int AS pending
           FROM pull_requests
          WHERE workspace_id = $1 AND repository_id = $2 AND files_ingested_at IS NULL`,
        [workspaceId, repository.id],
      );
      if (rows[0]!.pending === 0) continue;
      const job = await enqueue(tx, {
        workspaceId,
        type: 'repository.file_fill_in',
        payload: { repositoryId: repository.id },
        dedupeKey: `file_fill_in:${repository.id}`,
        priority: FILL_IN_JOB_PRIORITY,
      });
      if (job) enqueued++;
    }
    return enqueued;
  });
}
