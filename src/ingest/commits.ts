/**
 * Default-branch commit ingestion (spec: github-data-sync "Default-branch commits are ingested
 * independently of pull requests", design.md D5).
 *
 * One paged query per repository per window rather than one per pull request, so commit activity
 * is a complete series: a commit pushed straight to the default branch appears without any pull
 * request record, and a commit that also belongs to a pull request resolves to this one row,
 * associated with both.
 */
import type { Database, Queryable } from '../db/driver';
import type { GitHubGraphQLClient } from '../github/graphql';
import type { RateLimitTracker } from '../github/rate-limit';
import { enqueue } from '../jobs/queue';
import { recordCoverage } from '../repositories/coverage';
import {
  finishSyncRun,
  getRepository,
  listRepositories,
  recordSyncFailure,
  startSyncRun,
} from '../repositories/store';
import { mapGraphQLActor } from './graphql-map';
import { parseDate, type NormalizedRepositoryCommit } from './model';
import { upsertContributor } from './normalize';

/** Pages per run, and commits per page. Bounded so one repository cannot monopolise a worker. */
export const COMMIT_PAGES_PER_RUN = 5;
export const COMMIT_PAGE_SIZE = 100;

export interface CommitSyncDeps {
  graphql: GitHubGraphQLClient;
  rateLimit: RateLimitTracker;
  now?: () => Date;
}

export interface CommitSyncOutcome {
  commits: number;
  pagesFetched: number;
  complete: boolean;
  unreachable: number;
}

/**
 * Write the commits of one window.
 *
 * `reachable` is the mechanism for a rewritten branch: a commit previously ingested inside the
 * window that this pass no longer sees is marked unreachable, never deleted, so history stays
 * explainable and the row can be restored if the branch is (spec: "The default branch is
 * rewritten").
 */
export async function persistRepositoryCommits(
  db: Queryable,
  input: {
    workspaceId: string;
    repositoryId: string;
    commits: readonly NormalizedRepositoryCommit[];
  },
): Promise<{ written: number }> {
  for (const commit of input.commits) {
    const authorId = commit.author
      ? await upsertContributor(db, input.workspaceId, commit.author, commit.committedAt)
      : null;

    await db.query(
      `INSERT INTO repository_commits
         (workspace_id, repository_id, oid, node_id, author_contributor_id, committed_at,
          additions, deletions, changed_files, message_headline, pull_request_id, reachable)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
               (SELECT pull_request_id FROM pr_commits
                 WHERE workspace_id = $1 AND oid = $3 LIMIT 1),
               true)
       ON CONFLICT (workspace_id, repository_id, oid) DO UPDATE
         SET node_id = COALESCE(EXCLUDED.node_id, repository_commits.node_id),
             author_contributor_id = COALESCE(EXCLUDED.author_contributor_id,
                                              repository_commits.author_contributor_id),
             committed_at = EXCLUDED.committed_at,
             additions = COALESCE(EXCLUDED.additions, repository_commits.additions),
             deletions = COALESCE(EXCLUDED.deletions, repository_commits.deletions),
             changed_files = COALESCE(EXCLUDED.changed_files, repository_commits.changed_files),
             message_headline = COALESCE(EXCLUDED.message_headline,
                                         repository_commits.message_headline),
             pull_request_id = COALESCE(EXCLUDED.pull_request_id,
                                        repository_commits.pull_request_id),
             reachable = true`,
      [
        input.workspaceId,
        input.repositoryId,
        commit.oid,
        commit.nodeId,
        authorId,
        commit.committedAt,
        commit.additions,
        commit.deletions,
        commit.changedFiles,
        commit.messageHeadline,
      ],
    );
  }
  return { written: input.commits.length };
}

/** Retire commits inside a fully walked window that this pass no longer sees on the branch. */
export async function markUnreachableOutsideWindow(
  db: Queryable,
  input: {
    workspaceId: string;
    repositoryId: string;
    windowStart: Date;
    windowEnd: Date;
    seenOids: readonly string[];
  },
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE repository_commits
        SET reachable = false
      WHERE workspace_id = $1 AND repository_id = $2
        AND committed_at >= $3 AND committed_at < $4
        AND reachable = true
        AND NOT (oid = ANY($5::text[]))`,
    [
      input.workspaceId,
      input.repositoryId,
      input.windowStart,
      input.windowEnd,
      [...input.seenOids],
    ],
  );
  return rowCount;
}

/** Below incremental sync (100) in the queue's ascending priority, above the file fill-in. */
export const COMMIT_SYNC_JOB_PRIORITY = 120;

/**
 * One commit sync per in-scope, backfilled repository. Windowed from the repository's recorded
 * commit coverage so a settled repository re-walks only recent history.
 */
export async function enqueueWorkspaceCommitSyncs(
  database: Database,
  workspaceId: string,
  options: { windowDays: number; now?: Date },
): Promise<number> {
  const now = options.now ?? new Date();
  return database.transaction(async (tx) => {
    const repositories = await listRepositories(tx, workspaceId, { inScopeOnly: true });
    let enqueued = 0;
    for (const repository of repositories) {
      if (repository.backfillState !== 'complete') continue;
      const since = new Date(now.getTime() - options.windowDays * 24 * 3600_000);
      const job = await enqueue(tx, {
        workspaceId,
        type: 'repository.commit_sync',
        payload: { repositoryId: repository.id, since: since.toISOString() },
        dedupeKey: `commit_sync:${repository.id}`,
        priority: COMMIT_SYNC_JOB_PRIORITY,
      });
      if (job) enqueued++;
    }
    return enqueued;
  });
}

/**
 * Walk the default branch over a window, newest first. Bounded per run and resumable by cursor,
 * in the same shape as the backfill it runs alongside.
 */
export async function runDefaultBranchCommitSync(
  database: Database,
  input: {
    workspaceId: string;
    repositoryId: string;
    since: Date;
    until?: Date;
    cursor?: string | null;
  },
  deps: CommitSyncDeps,
): Promise<CommitSyncOutcome> {
  const now = deps.now?.() ?? new Date();
  const until = input.until ?? now;
  const repository = await getRepository(database, input.repositoryId);
  if (!repository || repository.workspaceId !== input.workspaceId) {
    throw new Error(`Repository ${input.repositoryId} not found in workspace ${input.workspaceId}`);
  }
  if (!repository.inScope) {
    return { commits: 0, pagesFetched: 0, complete: true, unreachable: 0 };
  }

  const syncRunId = await startSyncRun(database, {
    workspaceId: input.workspaceId,
    repositoryId: repository.id,
    kind: 'commit_sync',
    windowStart: input.since,
    windowEnd: until,
  });

  let cursor = input.cursor ?? null;
  let pagesFetched = 0;
  let commits = 0;
  let complete = false;
  let unreachable = 0;
  const seenOids: string[] = [];

  try {
    while (pagesFetched < COMMIT_PAGES_PER_RUN) {
      deps.rateLimit.assertHeadroom(`commit sync of ${repository.fullName}`);

      const page = await deps.graphql.fetchDefaultBranchCommits({
        owner: repository.ownerLogin,
        name: repository.name,
        since: input.since,
        until,
        pageSize: COMMIT_PAGE_SIZE,
        after: cursor,
      });
      pagesFetched++;

      const normalized = page.nodes.flatMap((node) => {
        const committedAt = parseDate(node.committedDate);
        if (!committedAt) return [];
        return [
          {
            oid: node.oid,
            nodeId: node.id,
            author: mapGraphQLActor(node.author?.user ?? null),
            committedAt,
            additions: node.additions ?? null,
            deletions: node.deletions ?? null,
            changedFiles: node.changedFilesIfAvailable ?? null,
            messageHeadline: node.messageHeadline ?? null,
          } satisfies NormalizedRepositoryCommit,
        ];
      });

      await database.transaction(async (tx) => {
        await persistRepositoryCommits(tx, {
          workspaceId: input.workspaceId,
          repositoryId: repository.id,
          commits: normalized,
        });
      });
      commits += normalized.length;
      for (const commit of normalized) seenOids.push(commit.oid);

      cursor = page.endCursor;
      if (!page.hasNextPage) {
        complete = true;
        break;
      }
    }

    if (complete) {
      // Only a fully walked window can distinguish "no longer on the branch" from "not reached
      // yet", so reachability is only ever retired here.
      unreachable = await markUnreachableOutsideWindow(database, {
        workspaceId: input.workspaceId,
        repositoryId: repository.id,
        windowStart: input.since,
        windowEnd: until,
        seenOids,
      });
      await recordCoverage(database, {
        workspaceId: input.workspaceId,
        repositoryId: repository.id,
        dataClass: 'default_branch_commits',
        coveredFrom: input.since,
      });
    }

    await finishSyncRun(database, syncRunId, {
      status: complete ? 'succeeded' : 'paused',
      pullRequestsSeen: commits,
      cursor,
    });

    return { commits, pagesFetched, complete, unreachable };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishSyncRun(database, syncRunId, {
      status: 'failed',
      pullRequestsSeen: commits,
      error: message,
      cursor,
    });
    await recordSyncFailure(database, repository.id, message);
    throw error;
  }
}
