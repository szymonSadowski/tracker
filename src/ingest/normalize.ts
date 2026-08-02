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
import { isBotAccount, type NormalizedActor, type NormalizedPullRequest } from './model';

export type IngestSource = 'graphql_backfill' | 'rest_incremental' | 'webhook';

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
  return rows[0]!.id;
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
        opened_at, ready_for_review_at, first_commit_at, closed_at, merged_at, github_updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (workspace_id, node_id) DO UPDATE
       SET repository_id = EXCLUDED.repository_id,
           number = EXCLUDED.number,
           title = EXCLUDED.title,
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
            pull_requests.github_updated_at, pull_requests.repository_id)
       IS DISTINCT FROM
           (EXCLUDED.title, EXCLUDED.state, EXCLUDED.is_draft,
            COALESCE(EXCLUDED.additions, pull_requests.additions),
            COALESCE(EXCLUDED.deletions, pull_requests.deletions),
            COALESCE(EXCLUDED.changed_files, pull_requests.changed_files),
            COALESCE(EXCLUDED.ready_for_review_at, pull_requests.ready_for_review_at),
            EXCLUDED.closed_at, EXCLUDED.merged_at, EXCLUDED.github_updated_at,
            EXCLUDED.repository_id)
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
