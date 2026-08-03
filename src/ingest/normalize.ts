/**
 * The normalizer (design.md D2/D4): the one write path into normalized storage.
 *
 * Backfill, incremental sync, and reprocessing all call `persistPullRequest`; a webhook path
 * later becomes a third caller with no new write logic. Every write is an upsert keyed by GitHub
 * node id scoped to the workspace, so replaying an overlapping window creates no rows and changes
 * no values.
 */
import { createHash } from 'node:crypto';
import type { Queryable } from '../db/driver';
import { enqueue } from '../jobs/queue';
import {
  isBotAccount,
  type NormalizedActor,
  type NormalizedCommitFiles,
  type NormalizedFile,
  type NormalizedPullRequest,
  type NormalizedReviewComment,
} from './model';
import { recordCoverage } from '../repositories/coverage';

export type IngestSource = 'graphql_backfill' | 'graphql_history' | 'rest_incremental' | 'webhook';

export interface PersistOptions {
  workspaceId: string;
  repositoryId: string;
  pullRequest: NormalizedPullRequest;
  source: IngestSource;
  /** The provider payload as received, retained so this record can be rebuilt without GitHub. */
  rawPayload?: unknown;
  /** Reprocessing already reads from raw storage; it must not write a second copy. */
  storeRaw?: boolean;
  /** Analysis is enqueued in the same transaction as the data that justifies it (D11). */
  enqueueAnalysis?: boolean;
}

export interface PersistResult {
  pullRequestId: string;
  created: boolean;
  contributorsSeen: number;
}

export function hashPayload(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(payload) ?? 'null')
    .digest('hex');
}

/**
 * Upsert a contributor. `first_seen_at`/`last_seen_at` move only outward and are derived from
 * payload timestamps, never from wall-clock time, so re-ingesting the same payload is a no-op.
 */
export async function upsertContributor(
  db: Queryable,
  workspaceId: string,
  actor: NormalizedActor,
  seenAt: Date,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO contributors
       (workspace_id, node_id, github_user_id, login, name, avatar_url, account_type, is_bot,
        first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     ON CONFLICT (workspace_id, node_id) DO UPDATE
       SET login = EXCLUDED.login,
           name = COALESCE(EXCLUDED.name, contributors.name),
           avatar_url = COALESCE(EXCLUDED.avatar_url, contributors.avatar_url),
           github_user_id = COALESCE(EXCLUDED.github_user_id, contributors.github_user_id),
           account_type = EXCLUDED.account_type,
           is_bot = EXCLUDED.is_bot,
           first_seen_at = LEAST(contributors.first_seen_at, EXCLUDED.first_seen_at),
           last_seen_at = GREATEST(contributors.last_seen_at, EXCLUDED.last_seen_at)
     RETURNING id`,
    [
      workspaceId,
      actor.nodeId,
      actor.githubUserId ?? null,
      actor.login,
      actor.name ?? null,
      actor.avatarUrl ?? null,
      actor.accountType,
      isBotAccount(actor.accountType),
      seenAt,
    ],
  );
  const contributorId = rows[0]!.id;

  // A newly discovered human account opens a workspace membership interval, which is what a
  // prorated throughput denominator is computed from (design.md D4). Bots never enter one.
  if (!isBotAccount(actor.accountType)) {
    await db.query(
      `INSERT INTO workspace_memberships (workspace_id, contributor_id, started_at)
       SELECT $1, $2, (SELECT first_seen_at FROM contributors WHERE id = $2)
        WHERE NOT EXISTS (
          SELECT 1 FROM workspace_memberships
           WHERE workspace_id = $1 AND contributor_id = $2 AND ended_at IS NULL
        )`,
      [workspaceId, contributorId],
    );
  }

  return contributorId;
}

async function storeRawPayload(
  db: Queryable,
  options: PersistOptions,
  payload: unknown,
): Promise<void> {
  await db.query(
    `INSERT INTO github_raw_events
       (workspace_id, repository_id, source, entity_type, entity_node_id, payload, payload_hash,
        entity_updated_at)
     VALUES ($1, $2, $3, 'pull_request', $4, $5::jsonb, $6, $7)
     ON CONFLICT (workspace_id, entity_node_id, payload_hash)
       DO UPDATE SET fetched_at = now()`,
    [
      options.workspaceId,
      options.repositoryId,
      options.source,
      options.pullRequest.nodeId,
      JSON.stringify(payload),
      hashPayload(payload),
      options.pullRequest.githubUpdatedAt,
    ],
  );
}

/**
 * Per-file diff statistics for one pull request.
 *
 * The upsert is guarded on a real difference and the delete is scoped to paths no longer present,
 * so re-ingesting an identical list creates no rows and changes no stored value (spec:
 * github-data-sync "The same file list is ingested twice").
 */
async function persistFiles(
  db: Queryable,
  workspaceId: string,
  pullRequestId: string,
  files: readonly NormalizedFile[],
): Promise<void> {
  for (const file of files) {
    await db.query(
      `INSERT INTO pr_files
         (workspace_id, pull_request_id, path, additions, deletions, change_kind)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (workspace_id, pull_request_id, path) DO UPDATE
         SET additions = EXCLUDED.additions,
             deletions = EXCLUDED.deletions,
             change_kind = EXCLUDED.change_kind,
             ingested_at = now()
       WHERE (pr_files.additions, pr_files.deletions, pr_files.change_kind)
         IS DISTINCT FROM (EXCLUDED.additions, EXCLUDED.deletions, EXCLUDED.change_kind)`,
      [workspaceId, pullRequestId, file.path, file.additions, file.deletions, file.changeKind],
    );
  }

  await db.query(
    `DELETE FROM pr_files
      WHERE workspace_id = $1 AND pull_request_id = $2 AND NOT (path = ANY($3::text[]))`,
    [workspaceId, pullRequestId, files.map((file) => file.path)],
  );
}

async function persistReviewComments(
  db: Queryable,
  workspaceId: string,
  pullRequestId: string,
  comments: readonly NormalizedReviewComment[],
  options: { complete: boolean; resolveActor: (actor: NormalizedActor | null) => Promise<string | null> },
): Promise<void> {
  for (const comment of comments) {
    const authorId = await options.resolveActor(comment.author);
    await db.query(
      `INSERT INTO pr_review_comments
         (workspace_id, pull_request_id, review_id, author_contributor_id, node_id, submitted_at)
       VALUES ($1,$2,(SELECT id FROM pr_reviews WHERE workspace_id = $1 AND node_id = $3),$4,$5,$6)
       ON CONFLICT (workspace_id, node_id) DO UPDATE
         SET pull_request_id = EXCLUDED.pull_request_id,
             review_id = COALESCE(EXCLUDED.review_id, pr_review_comments.review_id),
             author_contributor_id = COALESCE(EXCLUDED.author_contributor_id,
                                              pr_review_comments.author_contributor_id),
             submitted_at = EXCLUDED.submitted_at
       WHERE (pr_review_comments.pull_request_id, pr_review_comments.submitted_at)
         IS DISTINCT FROM (EXCLUDED.pull_request_id, EXCLUDED.submitted_at)`,
      [
        workspaceId,
        pullRequestId,
        comment.reviewNodeId,
        authorId,
        comment.nodeId,
        comment.submittedAt,
      ],
    );
  }

  // A comment deleted on GitHub disappears from the next complete fetch; retiring the row is what
  // keeps review depth from counting a phantom (spec: "A comment is edited or deleted on GitHub").
  if (options.complete) {
    await db.query(
      `DELETE FROM pr_review_comments
        WHERE workspace_id = $1 AND pull_request_id = $2 AND NOT (node_id = ANY($3::text[]))`,
      [workspaceId, pullRequestId, comments.map((comment) => comment.nodeId)],
    );
  }
}

async function persistCommitFiles(
  db: Queryable,
  workspaceId: string,
  pullRequestId: string,
  commitFiles: readonly NormalizedCommitFiles[],
): Promise<void> {
  for (const commit of commitFiles) {
    for (const file of commit.files) {
      await db.query(
        `INSERT INTO pr_commit_files
           (workspace_id, pull_request_id, commit_node_id, commit_oid, path, additions, deletions,
            change_kind, committed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (workspace_id, commit_node_id, path) DO UPDATE
           SET pull_request_id = EXCLUDED.pull_request_id,
               commit_oid = COALESCE(EXCLUDED.commit_oid, pr_commit_files.commit_oid),
               additions = EXCLUDED.additions,
               deletions = EXCLUDED.deletions,
               change_kind = EXCLUDED.change_kind,
               committed_at = EXCLUDED.committed_at
         WHERE (pr_commit_files.additions, pr_commit_files.deletions, pr_commit_files.change_kind,
                pr_commit_files.committed_at)
           IS DISTINCT FROM (EXCLUDED.additions, EXCLUDED.deletions, EXCLUDED.change_kind,
                             EXCLUDED.committed_at)`,
        [
          workspaceId,
          pullRequestId,
          commit.commitNodeId,
          commit.commitOid,
          file.path,
          file.additions,
          file.deletions,
          file.changeKind,
          commit.committedAt,
        ],
      );
    }
  }
}

type ActorResolver = (actor: NormalizedActor | null) => Promise<string | null>;

/** Memoized within one persist call so a contributor appearing many times is upserted once. */
function actorResolver(db: Queryable, workspaceId: string, seenAt: Date): ActorResolver {
  const contributorIds = new Map<string, string>();
  return async (actor) => {
    if (!actor) return null;
    const cached = contributorIds.get(actor.nodeId);
    if (cached) return cached;
    const id = await upsertContributor(db, workspaceId, actor, seenAt);
    contributorIds.set(actor.nodeId, id);
    return id;
  };
}

export interface FileDataOptions {
  workspaceId: string;
  repositoryId: string;
  pullRequestId: string;
  /** The pull request's creation time — how far back file coverage now reaches. */
  openedAt: Date;
  files?: readonly NormalizedFile[] | null;
  filesTruncated?: boolean;
  reviewComments?: readonly NormalizedReviewComment[] | null;
  reviewCommentsComplete?: boolean;
  commitFiles?: readonly NormalizedCommitFiles[] | null;
  /**
   * Analysis is re-enqueued when file data arrives, so a pull request analyzed before its files
   * were collected gains churn (spec: pr-metrics "File data arrives for a previously ingested
   * pull request").
   */
  enqueueAnalysis?: boolean;
  resolveActor?: ActorResolver;
}

/**
 * The file, comment, and commit-statistic half of a pull request's record.
 *
 * Called both by the full ingest and by the fill-in pass, which is what makes "file data ingested
 * by a later pass is identical to what the original path would have produced" a property of one
 * function rather than an agreement between two.
 */
export async function persistPullRequestFileData(
  db: Queryable,
  options: FileDataOptions,
): Promise<void> {
  const resolveActor = options.resolveActor ?? actorResolver(db, options.workspaceId, options.openedAt);

  if (options.files != null) {
    await persistFiles(db, options.workspaceId, options.pullRequestId, options.files);
    // The marker records that file data has been collected, not when it was last refetched, so
    // replaying an identical payload leaves the row untouched.
    await db.query(
      `UPDATE pull_requests
          SET files_truncated = $2, files_ingested_at = COALESCE(files_ingested_at, now())
        WHERE id = $1 AND (files_truncated IS DISTINCT FROM $2 OR files_ingested_at IS NULL)`,
      [options.pullRequestId, options.filesTruncated ?? false],
    );
    // Churn coverage is reported separately from pull request coverage and extends backwards as
    // the fill-in pass runs (spec: "Pull requests are covered but file data is not").
    await recordCoverage(db, {
      workspaceId: options.workspaceId,
      repositoryId: options.repositoryId,
      dataClass: 'file_diffs',
      coveredFrom: options.openedAt,
    });
  }

  if (options.reviewComments != null) {
    await persistReviewComments(
      db,
      options.workspaceId,
      options.pullRequestId,
      options.reviewComments,
      { complete: options.reviewCommentsComplete ?? false, resolveActor },
    );
    await db.query(
      `UPDATE pull_requests SET review_comments_ingested_at = now()
        WHERE id = $1 AND review_comments_ingested_at IS NULL`,
      [options.pullRequestId],
    );
  }

  if (options.commitFiles != null) {
    await persistCommitFiles(
      db,
      options.workspaceId,
      options.pullRequestId,
      options.commitFiles,
    );
  }

  if (options.enqueueAnalysis) {
    await enqueue(db, {
      workspaceId: options.workspaceId,
      type: 'pull_request.analyze',
      payload: { pullRequestId: options.pullRequestId },
      dedupeKey: `analyze:${options.pullRequestId}`,
      priority: 80,
    });
  }
}

export async function persistPullRequest(
  db: Queryable,
  options: PersistOptions,
): Promise<PersistResult> {
  const pr = options.pullRequest;
  const seenAt = pr.githubUpdatedAt;

  if (options.storeRaw !== false && options.rawPayload !== undefined) {
    await storeRawPayload(db, options, options.rawPayload);
  }

  const contributorIds = new Map<string, string>();
  const resolveActor = async (actor: NormalizedActor | null): Promise<string | null> => {
    if (!actor) return null;
    const cached = contributorIds.get(actor.nodeId);
    if (cached) return cached;
    const id = await upsertContributor(db, options.workspaceId, actor, seenAt);
    contributorIds.set(actor.nodeId, id);
    return id;
  };

  const authorId = await resolveActor(pr.author);
  const firstCommitAt = pr.commits.reduce<Date | null>(
    (earliest, commit) =>
      earliest === null || commit.committedAt < earliest ? commit.committedAt : earliest,
    null,
  );

  const existing = await db.query<{ id: string }>(
    'SELECT id FROM pull_requests WHERE workspace_id = $1 AND node_id = $2',
    [options.workspaceId, pr.nodeId],
  );
  const created = existing.rows.length === 0;

  // The DO UPDATE is guarded on a real difference so that replaying a window leaves `updated_at`
  // — and therefore every downstream "has this changed?" check — untouched.
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO pull_requests
       (workspace_id, repository_id, node_id, number, title, url, state, is_draft,
        author_contributor_id, base_ref, head_ref, additions, deletions, changed_files,
        opened_at, ready_for_review_at, first_commit_at, closed_at, merged_at, github_updated_at,
        body)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (workspace_id, node_id) DO UPDATE
       SET repository_id = EXCLUDED.repository_id,
           number = EXCLUDED.number,
           title = EXCLUDED.title,
           body = COALESCE(EXCLUDED.body, pull_requests.body),
           url = COALESCE(EXCLUDED.url, pull_requests.url),
           state = EXCLUDED.state,
           is_draft = EXCLUDED.is_draft,
           author_contributor_id = COALESCE(EXCLUDED.author_contributor_id,
                                            pull_requests.author_contributor_id),
           base_ref = COALESCE(EXCLUDED.base_ref, pull_requests.base_ref),
           head_ref = COALESCE(EXCLUDED.head_ref, pull_requests.head_ref),
           additions = COALESCE(EXCLUDED.additions, pull_requests.additions),
           deletions = COALESCE(EXCLUDED.deletions, pull_requests.deletions),
           changed_files = COALESCE(EXCLUDED.changed_files, pull_requests.changed_files),
           opened_at = EXCLUDED.opened_at,
           ready_for_review_at = COALESCE(EXCLUDED.ready_for_review_at,
                                          pull_requests.ready_for_review_at),
           first_commit_at = COALESCE(EXCLUDED.first_commit_at, pull_requests.first_commit_at),
           closed_at = EXCLUDED.closed_at,
           merged_at = EXCLUDED.merged_at,
           github_updated_at = EXCLUDED.github_updated_at,
           updated_at = now()
     WHERE (pull_requests.title, pull_requests.state, pull_requests.is_draft,
            pull_requests.additions, pull_requests.deletions, pull_requests.changed_files,
            pull_requests.ready_for_review_at, pull_requests.closed_at, pull_requests.merged_at,
            pull_requests.github_updated_at, pull_requests.repository_id, pull_requests.body)
       IS DISTINCT FROM
           (EXCLUDED.title, EXCLUDED.state, EXCLUDED.is_draft,
            COALESCE(EXCLUDED.additions, pull_requests.additions),
            COALESCE(EXCLUDED.deletions, pull_requests.deletions),
            COALESCE(EXCLUDED.changed_files, pull_requests.changed_files),
            COALESCE(EXCLUDED.ready_for_review_at, pull_requests.ready_for_review_at),
            EXCLUDED.closed_at, EXCLUDED.merged_at, EXCLUDED.github_updated_at,
            EXCLUDED.repository_id, COALESCE(EXCLUDED.body, pull_requests.body))
     RETURNING id`,
    [
      options.workspaceId,
      options.repositoryId,
      pr.nodeId,
      pr.number,
      pr.title,
      pr.url,
      pr.state,
      pr.isDraft,
      authorId,
      pr.baseRef,
      pr.headRef,
      pr.additions,
      pr.deletions,
      pr.changedFiles,
      pr.openedAt,
      pr.readyForReviewAt,
      firstCommitAt,
      pr.closedAt,
      pr.mergedAt,
      pr.githubUpdatedAt,
      pr.body,
    ],
  );

  // The guarded upsert returns nothing when the row was already identical.
  const pullRequestId = rows[0]?.id ?? existing.rows[0]!.id;

  for (const review of pr.reviews) {
    const reviewerId = await resolveActor(review.reviewer);
    await db.query(
      `INSERT INTO pr_reviews
         (workspace_id, pull_request_id, node_id, reviewer_contributor_id, state, body_present,
          submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workspace_id, node_id) DO UPDATE
         SET pull_request_id = EXCLUDED.pull_request_id,
             reviewer_contributor_id = COALESCE(EXCLUDED.reviewer_contributor_id,
                                                pr_reviews.reviewer_contributor_id),
             state = EXCLUDED.state,
             body_present = EXCLUDED.body_present,
             submitted_at = EXCLUDED.submitted_at`,
      [
        options.workspaceId,
        pullRequestId,
        review.nodeId,
        reviewerId,
        review.state,
        review.bodyPresent,
        review.submittedAt,
      ],
    );
  }

  for (const commit of pr.commits) {
    const commitAuthorId = await resolveActor(commit.author);
    await db.query(
      `INSERT INTO pr_commits
         (workspace_id, pull_request_id, node_id, oid, author_contributor_id, message_headline,
          additions, deletions, changed_files, authored_at, committed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (workspace_id, pull_request_id, node_id) DO UPDATE
         SET oid = COALESCE(EXCLUDED.oid, pr_commits.oid),
             author_contributor_id = COALESCE(EXCLUDED.author_contributor_id,
                                              pr_commits.author_contributor_id),
             message_headline = COALESCE(EXCLUDED.message_headline, pr_commits.message_headline),
             additions = COALESCE(EXCLUDED.additions, pr_commits.additions),
             deletions = COALESCE(EXCLUDED.deletions, pr_commits.deletions),
             changed_files = COALESCE(EXCLUDED.changed_files, pr_commits.changed_files),
             authored_at = COALESCE(EXCLUDED.authored_at, pr_commits.authored_at),
             committed_at = EXCLUDED.committed_at`,
      [
        options.workspaceId,
        pullRequestId,
        commit.nodeId,
        commit.oid,
        commitAuthorId,
        commit.messageHeadline,
        commit.additions,
        commit.deletions,
        commit.changedFiles,
        commit.authoredAt,
        commit.committedAt,
      ],
    );
  }

  for (const event of pr.events) {
    const actorId = await resolveActor(event.actor);
    await db.query(
      `INSERT INTO pr_events
         (workspace_id, pull_request_id, event_type, occurred_at, actor_contributor_id,
          dedupe_key, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (workspace_id, pull_request_id, dedupe_key) DO UPDATE
         SET event_type = EXCLUDED.event_type,
             occurred_at = EXCLUDED.occurred_at,
             actor_contributor_id = COALESCE(EXCLUDED.actor_contributor_id,
                                             pr_events.actor_contributor_id),
             details = EXCLUDED.details`,
      [
        options.workspaceId,
        pullRequestId,
        event.type,
        event.occurredAt,
        actorId,
        event.dedupeKey,
        JSON.stringify(event.details ?? {}),
      ],
    );
  }

  // Reviews are written before their comments so a comment can resolve its review by node id.
  await persistPullRequestFileData(db, {
    workspaceId: options.workspaceId,
    repositoryId: options.repositoryId,
    pullRequestId,
    openedAt: pr.openedAt,
    files: pr.files,
    filesTruncated: pr.filesTruncated,
    reviewComments: pr.reviewComments,
    reviewCommentsComplete: pr.reviewCommentsComplete,
    commitFiles: pr.commitFiles,
    resolveActor,
  });

  await recordCoverage(db, {
    workspaceId: options.workspaceId,
    repositoryId: options.repositoryId,
    dataClass: 'pull_requests',
    coveredFrom: pr.openedAt,
  });

  if (options.enqueueAnalysis !== false) {
    await enqueue(db, {
      workspaceId: options.workspaceId,
      type: 'pull_request.analyze',
      payload: { pullRequestId },
      dedupeKey: `analyze:${pullRequestId}`,
      priority: 80,
    });
  }

  return { pullRequestId, created, contributorsSeen: contributorIds.size };
}
