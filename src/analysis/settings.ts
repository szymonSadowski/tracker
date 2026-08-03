/**
 * Workspace metric settings, and the definition revision they participate in.
 *
 * A metric's meaning is the code revision *and* the configuration it read. Recording both on every
 * analysis row is what lets a recompute be targeted at the rows a change actually affects, and
 * what keeps a historical number explainable after the configuration moves (spec: pr-metrics
 * "Metric definitions declare their revision and their inputs").
 */
import { createHash } from 'node:crypto';
import type { Queryable } from '../db/driver';
import { COMPUTED_VERSION } from './metrics';

export interface MetricSettings {
  timeZone: string;
  reworkRecencyDays: number;
  churnExclusionPatterns: string[];
  minSampleSize: number;
}

/** Used for a workspace with no stored row, and as the shape of every default. */
export const DEFAULT_METRIC_SETTINGS: MetricSettings = {
  timeZone: 'UTC',
  reworkRecencyDays: 21,
  churnExclusionPatterns: [
    '**/package-lock.json',
    '**/yarn.lock',
    '**/pnpm-lock.yaml',
    '**/Cargo.lock',
    '**/go.sum',
    '**/*.lock',
    '**/vendor/**',
    '**/generated/**',
    '**/*.generated.*',
    '**/dist/**',
    '**/build/**',
    '**/node_modules/**',
    '**/*.min.js',
    '**/*.snap',
  ],
  minSampleSize: 5,
};

export async function loadMetricSettings(
  db: Queryable,
  workspaceId: string,
): Promise<MetricSettings> {
  const { rows } = await db.query<{
    time_zone: string;
    rework_recency_days: number;
    churn_exclusion_patterns: string[];
    min_sample_size: number;
  }>(
    `SELECT time_zone, rework_recency_days, churn_exclusion_patterns, min_sample_size
       FROM workspace_metric_settings WHERE workspace_id = $1`,
    [workspaceId],
  );
  const row = rows[0];
  if (!row) return DEFAULT_METRIC_SETTINGS;
  return {
    timeZone: row.time_zone,
    reworkRecencyDays: row.rework_recency_days,
    churnExclusionPatterns: row.churn_exclusion_patterns,
    minSampleSize: row.min_sample_size,
  };
}

export async function saveMetricSettings(
  db: Queryable,
  workspaceId: string,
  settings: Partial<MetricSettings>,
): Promise<MetricSettings> {
  const current = await loadMetricSettings(db, workspaceId);
  const merged = { ...current, ...settings };
  await db.query(
    `INSERT INTO workspace_metric_settings
       (workspace_id, time_zone, rework_recency_days, churn_exclusion_patterns, min_sample_size)
     VALUES ($1,$2,$3,$4::text[],$5)
     ON CONFLICT (workspace_id) DO UPDATE
       SET time_zone = EXCLUDED.time_zone,
           rework_recency_days = EXCLUDED.rework_recency_days,
           churn_exclusion_patterns = EXCLUDED.churn_exclusion_patterns,
           min_sample_size = EXCLUDED.min_sample_size,
           updated_at = now()`,
    [
      workspaceId,
      merged.timeZone,
      merged.reworkRecencyDays,
      merged.churnExclusionPatterns,
      merged.minSampleSize,
    ],
  );
  return merged;
}

/**
 * The full identity of the definitions that produced a row: the code revision plus the settings
 * that feed it. Two rows carrying the same revision were computed the same way.
 */
export function definitionRevision(settings: MetricSettings): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        version: COMPUTED_VERSION,
        reworkRecencyDays: settings.reworkRecencyDays,
        churnExclusionPatterns: [...settings.churnExclusionPatterns].sort(),
      }),
    )
    .digest('hex')
    .slice(0, 12);
  return `v${COMPUTED_VERSION}:${digest}`;
}
