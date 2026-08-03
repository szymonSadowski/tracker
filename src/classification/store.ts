/**
 * Classification persistence: eligibility, results, owner corrections, and the per-workspace
 * settings that bound the work (spec: work-classification).
 *
 * Nothing here touches a deterministic metric. `pr_classifications` is its own table precisely so
 * that dropping it, disabling it, or failing to write it leaves every latency, throughput, churn,
 * and size number exactly as it was.
 */
import type { Queryable } from '../db/driver';
import {
  contentHash,
  CLASSIFICATION_VERSION,
  type ClassificationInput,
  type WorkType,
} from './model';

export interface ClassificationSettings {
  enabled: boolean;
  spendBoundCents: number | null;
  spendConsumedCents: number;
  spendPeriodStart: Date;
  pausedReason: string | null;
  confidenceThreshold: number;
}

export const DEFAULT_CLASSIFICATION_SETTINGS: ClassificationSettings = {
  // Off by default: the deterministic product is verified in production before an external
  // dependency is added to it (design.md migration plan step 8).
  enabled: false,
  spendBoundCents: null,
  spendConsumedCents: 0,
  spendPeriodStart: new Date(0),
  pausedReason: null,
  confidenceThreshold: 0.6,
};

export async function loadClassificationSettings(
  db: Queryable,
  workspaceId: string,
): Promise<ClassificationSettings> {
  const { rows } = await db.query<{
    enabled: boolean;
    spend_bound_cents: number | null;
    spend_consumed_cents: number;
    spend_period_start: Date;
    paused_reason: string | null;
    confidence_threshold: number;
  }>(
    `SELECT enabled, spend_bound_cents, spend_consumed_cents, spend_period_start, paused_reason,
            confidence_threshold
       FROM workspace_classification_settings WHERE workspace_id = $1`,
    [workspaceId],
  );
  const row = rows[0];
  if (!row) return DEFAULT_CLASSIFICATION_SETTINGS;
  return {
    enabled: row.enabled,
    spendBoundCents: row.spend_bound_cents,
    spendConsumedCents: row.spend_consumed_cents,
    spendPeriodStart: row.spend_period_start,
    pausedReason: row.paused_reason,
    confidenceThreshold: Number(row.confidence_threshold),
  };
}

export async function saveClassificationSettings(
  db: Queryable,
  workspaceId: string,
  settings: Partial<ClassificationSettings>,
): Promise<ClassificationSettings> {
  const merged = { ...(await loadClassificationSettings(db, workspaceId)), ...settings };
  await db.query(
    `INSERT INTO workspace_classification_settings
       (workspace_id, enabled, spend_bound_cents, spend_consumed_cents, spend_period_start,
        paused_reason, confidence_threshold)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (workspace_id) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           spend_bound_cents = EXCLUDED.spend_bound_cents,
           spend_consumed_cents = EXCLUDED.spend_consumed_cents,
           spend_period_start = EXCLUDED.spend_period_start,
           paused_reason = EXCLUDED.paused_reason,
           confidence_threshold = EXCLUDED.confidence_threshold,
           updated_at = now()`,
    [
      workspaceId,
      merged.enabled,
      merged.spendBoundCents,
      merged.spendConsumedCents,
      merged.spendPeriodStart,
      merged.pausedReason,
      merged.confidenceThreshold,
    ],
  );
  return merged;
}

/**
 * Pull requests eligible for classification: those whose classification inputs changed, or whose
 * revision is stale, excluding any an owner has corrected by hand.
 *
 * The hash comparison happens in SQL over stored data, so an unchanged pull request at the current
 * revision never reaches the provider at all.
 */
export async function listEligible(
  db: Queryable,
  workspaceId: string,
  options: { limit?: number; repositoryId?: string } = {},
): Promise<ClassificationInput[]> {
  const { rows } = await db.query<{
    id: string;
    title: string;
    body: string | null;
    additions: number | null;
    deletions: number | null;
    changed_files: number | null;
    commit_messages: string[] | null;
    changed_paths: string[] | null;
    stored_hash: string | null;
    stored_version: string | null;
  }>(
    `SELECT pr.id, pr.title, pr.body, pr.additions, pr.deletions, pr.changed_files,
            ARRAY(SELECT c.message_headline FROM pr_commits c
                   WHERE c.pull_request_id = pr.id AND c.message_headline IS NOT NULL
                   ORDER BY c.committed_at) AS commit_messages,
            ARRAY(SELECT f.path FROM pr_files f
                   WHERE f.pull_request_id = pr.id ORDER BY f.path) AS changed_paths,
            k.content_hash AS stored_hash, k.classification_version AS stored_version
       FROM pull_requests pr
       LEFT JOIN pr_classifications k
         ON k.workspace_id = pr.workspace_id AND k.pull_request_id = pr.id
      WHERE pr.workspace_id = $1
        AND ($2::uuid IS NULL OR pr.repository_id = $2)
        AND COALESCE(k.human_corrected, false) = false
      ORDER BY COALESCE(pr.merged_at, pr.opened_at) DESC
      LIMIT $3`,
    [workspaceId, options.repositoryId ?? null, options.limit ?? 100],
  );

  return rows
    .map((row) => ({
      input: {
        pullRequestId: row.id,
        title: row.title,
        body: row.body,
        commitMessages: row.commit_messages ?? [],
        changedPaths: row.changed_paths ?? [],
        additions: row.additions,
        deletions: row.deletions,
        changedFiles: row.changed_files,
      } satisfies ClassificationInput,
      storedHash: row.stored_hash,
      storedVersion: row.stored_version,
    }))
    .filter(
      ({ input, storedHash, storedVersion }) =>
        storedVersion !== CLASSIFICATION_VERSION || storedHash !== contentHash(input),
    )
    .map(({ input }) => input);
}

export interface StoredClassification {
  pullRequestId: string;
  status: 'classified' | 'failed';
  workType: WorkType | null;
  confidence: number | null;
  rationale: string | null;
  failureReason: string | null;
  humanCorrected: boolean;
}

/** Write one result. A correction is never overwritten by an automatic run. */
export async function recordClassification(
  db: Queryable,
  workspaceId: string,
  input: ClassificationInput,
  result:
    | { status: 'classified'; workType: WorkType; confidence: number; rationale: string }
    | { status: 'failed'; reason: string },
): Promise<void> {
  await db.query(
    `INSERT INTO pr_classifications
       (workspace_id, pull_request_id, status, work_type, confidence, rationale, failure_reason,
        content_hash, classification_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (workspace_id, pull_request_id) DO UPDATE
       SET status = EXCLUDED.status,
           work_type = EXCLUDED.work_type,
           confidence = EXCLUDED.confidence,
           rationale = EXCLUDED.rationale,
           failure_reason = EXCLUDED.failure_reason,
           content_hash = EXCLUDED.content_hash,
           classification_version = EXCLUDED.classification_version,
           updated_at = now()
     WHERE pr_classifications.human_corrected = false`,
    [
      workspaceId,
      input.pullRequestId,
      result.status,
      result.status === 'classified' ? result.workType : null,
      result.status === 'classified' ? result.confidence : null,
      result.status === 'classified' ? result.rationale : null,
      result.status === 'failed' ? result.reason : null,
      contentHash(input),
      CLASSIFICATION_VERSION,
    ],
  );
}

/**
 * An owner sets a work type by hand. The correction is marked and survives every later automatic
 * run (spec: "A corrected pull request is re-run"). Authorization is the caller's to establish —
 * the route resolves owner access before reaching here.
 */
export async function correctClassification(
  db: Queryable,
  workspaceId: string,
  pullRequestId: string,
  workType: WorkType,
  correctedBy: string,
): Promise<void> {
  const { rows } = await db.query<{
    title: string;
    body: string | null;
    commit_messages: string[] | null;
    changed_paths: string[] | null;
  }>(
    `SELECT pr.title, pr.body,
            ARRAY(SELECT c.message_headline FROM pr_commits c
                   WHERE c.pull_request_id = pr.id AND c.message_headline IS NOT NULL
                   ORDER BY c.committed_at) AS commit_messages,
            ARRAY(SELECT f.path FROM pr_files f
                   WHERE f.pull_request_id = pr.id ORDER BY f.path) AS changed_paths
       FROM pull_requests pr WHERE pr.workspace_id = $1 AND pr.id = $2`,
    [workspaceId, pullRequestId],
  );
  const row = rows[0];
  if (!row) throw new Error(`Pull request ${pullRequestId} not found in workspace ${workspaceId}`);

  const hash = contentHash({
    pullRequestId,
    title: row.title,
    body: row.body,
    commitMessages: row.commit_messages ?? [],
    changedPaths: row.changed_paths ?? [],
    additions: null,
    deletions: null,
    changedFiles: null,
  });

  await db.query(
    `INSERT INTO pr_classifications
       (workspace_id, pull_request_id, status, work_type, confidence, rationale, content_hash,
        classification_version, human_corrected, corrected_by)
     VALUES ($1,$2,'classified',$3,1,'Set by a workspace owner',$4,$5,true,$6)
     ON CONFLICT (workspace_id, pull_request_id) DO UPDATE
       SET status = 'classified',
           work_type = EXCLUDED.work_type,
           confidence = 1,
           rationale = EXCLUDED.rationale,
           failure_reason = NULL,
           human_corrected = true,
           corrected_by = EXCLUDED.corrected_by,
           updated_at = now()`,
    [workspaceId, pullRequestId, workType, hash, CLASSIFICATION_VERSION, correctedBy],
  );
}

export interface ClassificationState {
  enabled: boolean;
  classified: number;
  failed: number;
  pending: number;
  corrected: number;
  version: string;
  pausedReason: string | null;
}

/** What an owner sees: how much is classified, pending, and failed, and why it stopped. */
export async function classificationState(
  db: Queryable,
  workspaceId: string,
): Promise<ClassificationState> {
  const settings = await loadClassificationSettings(db, workspaceId);
  const { rows } = await db.query<{
    classified: number;
    failed: number;
    corrected: number;
    total: number;
  }>(
    `SELECT count(*) FILTER (WHERE k.status = 'classified')::int AS classified,
            count(*) FILTER (WHERE k.status = 'failed')::int AS failed,
            count(*) FILTER (WHERE k.human_corrected)::int AS corrected,
            (SELECT count(*)::int FROM pull_requests WHERE workspace_id = $1) AS total
       FROM pr_classifications k WHERE k.workspace_id = $1`,
    [workspaceId],
  );
  const row = rows[0]!;
  return {
    enabled: settings.enabled,
    classified: row.classified,
    failed: row.failed,
    corrected: row.corrected,
    pending: Math.max(0, row.total - row.classified - row.failed),
    version: CLASSIFICATION_VERSION,
    pausedReason: settings.pausedReason,
  };
}
