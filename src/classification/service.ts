/**
 * The classification run (spec: work-classification "Classification work is bounded and
 * observable", design.md D6).
 *
 * A run is two halves that can be hours apart: enqueue a batch, and later ingest its results. Both
 * halves degrade to absence — a provider that is down leaves pull requests unclassified and
 * eligible for a later run, and no deterministic metric notices.
 */
import type { Database } from '../db/driver';
import { enqueue } from '../jobs/queue';
import { pullRequestContent } from './prompt';
import type { ClassificationProvider } from './provider';
import {
  listEligible,
  loadClassificationSettings,
  recordClassification,
  saveClassificationSettings,
} from './store';
import type { ClassificationInput } from './model';

/** Below the file fill-in (150): classification never delays ingestion or analysis. */
export const CLASSIFICATION_JOB_PRIORITY = 200;

/** Pull requests per batch. Well under the API's ceiling; keeps a paused run cheap to resume. */
export const CLASSIFICATION_BATCH_SIZE = 100;

/**
 * A rough per-pull-request cost in cents, used to check a spend bound *before* enqueueing rather
 * than discovering it afterwards. Deliberately an estimate: the bound exists to stop runaway
 * spend, and refusing to start is the safe direction to be wrong in.
 */
export const ESTIMATED_CENTS_PER_CLASSIFICATION = 1;

export interface ClassifyOutcome {
  enqueued: number;
  batchId: string | null;
  /** Set when the run declined to start; the reason is visible to owners. */
  pausedReason: string | null;
}

export interface ClassifyDeps {
  provider: ClassificationProvider;
  batchSize?: number;
}

/**
 * Start a batch for the eligible pull requests, if the workspace is configured to allow it.
 *
 * Every gate here returns rather than throws: classification being off, paused, or out of budget
 * is a normal state of the product, not an error in it.
 */
export async function startClassificationBatch(
  database: Database,
  workspaceId: string,
  deps: ClassifyDeps,
): Promise<ClassifyOutcome> {
  const settings = await loadClassificationSettings(database, workspaceId);
  if (!settings.enabled) {
    return { enqueued: 0, batchId: null, pausedReason: 'Classification is disabled' };
  }

  const eligible = await listEligible(database, workspaceId, {
    limit: deps.batchSize ?? CLASSIFICATION_BATCH_SIZE,
  });
  if (eligible.length === 0) {
    return { enqueued: 0, batchId: null, pausedReason: null };
  }

  // The bound is enforced before the batch is enqueued, so reaching it pauses the work rather
  // than failing it midway (spec: "A spend bound is reached").
  const estimate = eligible.length * ESTIMATED_CENTS_PER_CLASSIFICATION;
  if (
    settings.spendBoundCents !== null &&
    settings.spendConsumedCents + estimate > settings.spendBoundCents
  ) {
    const reason =
      `Paused: classifying ${eligible.length} pull requests would exceed the ` +
      `${settings.spendBoundCents}c spend bound (${settings.spendConsumedCents}c used)`;
    await saveClassificationSettings(database, workspaceId, { pausedReason: reason });
    return { enqueued: 0, batchId: null, pausedReason: reason };
  }

  const { batchId } = await deps.provider.submit(
    eligible.map((input) => ({
      customId: input.pullRequestId,
      content: pullRequestContent(input),
    })),
  );

  await saveClassificationSettings(database, workspaceId, {
    spendConsumedCents: settings.spendConsumedCents + estimate,
    pausedReason: null,
  });

  await enqueue(database, {
    workspaceId,
    type: 'workspace.collect_classifications',
    payload: { batchId },
    dedupeKey: `classification:${batchId}`,
    priority: CLASSIFICATION_JOB_PRIORITY,
  });

  return { enqueued: eligible.length, batchId, pausedReason: null };
}

export interface CollectOutcome {
  classified: number;
  failed: number;
  /** The batch has not finished; the collecting job re-enqueues itself. */
  pending: boolean;
}

/**
 * Ingest a finished batch. Results arrive in any order and are matched back by `custom_id`; a
 * result for a pull request that has since been corrected by an owner is dropped by the write.
 */
export async function collectClassificationBatch(
  database: Database,
  workspaceId: string,
  batchId: string,
  deps: ClassifyDeps,
): Promise<CollectOutcome> {
  if (!(await deps.provider.ended(batchId))) {
    await enqueue(database, {
      workspaceId,
      type: 'workspace.collect_classifications',
      payload: { batchId },
      dedupeKey: `classification:${batchId}`,
      priority: CLASSIFICATION_JOB_PRIORITY,
      runAfter: new Date(Date.now() + 5 * 60_000),
    });
    return { classified: 0, failed: 0, pending: true };
  }

  const outcomes = await deps.provider.results(batchId);
  const inputs = new Map<string, ClassificationInput>(
    (await listEligible(database, workspaceId, { limit: CLASSIFICATION_BATCH_SIZE * 4 })).map(
      (input) => [input.pullRequestId, input],
    ),
  );

  let classified = 0;
  let failed = 0;
  for (const outcome of outcomes) {
    const input = inputs.get(outcome.customId);
    // The pull request changed or was corrected since the batch was submitted; the stale result
    // is dropped rather than written against content it no longer describes.
    if (!input) continue;

    await database.transaction((tx) =>
      recordClassification(
        tx,
        workspaceId,
        input,
        outcome.status === 'classified'
          ? {
              status: 'classified',
              workType: outcome.workType,
              confidence: outcome.confidence,
              rationale: outcome.rationale,
            }
          : { status: 'failed', reason: outcome.reason },
      ),
    );
    if (outcome.status === 'classified') classified++;
    else failed++;
  }

  return { classified, failed, pending: false };
}
