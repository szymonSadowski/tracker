/**
 * Benchmark tiers (spec: metric-aggregation "Comparable metrics carry a benchmark tier",
 * design.md D8).
 *
 * Thresholds are seeded configuration read at query time, not constants compiled into an
 * aggregate. Revising one re-tiers every existing aggregate without recomputing any of them, and a
 * surface can name the study a number came from rather than presenting an industry benchmark as a
 * target the workspace set. A metric with no configured threshold gets no tier, and none is
 * inferred from the others.
 */
import type { Queryable } from '../db/driver';

export type BenchmarkTier = 'elite' | 'good' | 'fair' | 'needs_focus';

export type BenchmarkUnit = 'seconds' | 'lines' | 'share' | 'per_contributor_day';

export interface BenchmarkThreshold {
  metric: string;
  tier: BenchmarkTier;
  lowerBound: number | null;
  upperBound: number | null;
  unit: BenchmarkUnit;
  source: string;
  studyDate: Date;
}

export interface BenchmarkAssignment {
  metric: string;
  /** Null when the metric has thresholds but the value is absent, or has no thresholds at all. */
  tier: BenchmarkTier | null;
  lowerBound: number | null;
  upperBound: number | null;
  unit: BenchmarkUnit;
  source: string;
  studyDate: Date;
  /** Every tier for the metric, so a surface can render the whole band, not just the hit one. */
  thresholds: BenchmarkThreshold[];
}

export async function loadBenchmarkThresholds(db: Queryable): Promise<BenchmarkThreshold[]> {
  const { rows } = await db.query<{
    metric: string;
    tier: BenchmarkTier;
    lower_bound: number | string | null;
    upper_bound: number | string | null;
    unit: BenchmarkUnit;
    source: string;
    study_date: Date;
  }>(
    `SELECT metric, tier, lower_bound, upper_bound, unit, source, study_date
       FROM benchmark_thresholds
      ORDER BY metric, lower_bound NULLS FIRST`,
  );
  return rows.map((row) => ({
    metric: row.metric,
    tier: row.tier,
    lowerBound: row.lower_bound === null ? null : Number(row.lower_bound),
    upperBound: row.upper_bound === null ? null : Number(row.upper_bound),
    unit: row.unit,
    source: row.source,
    studyDate: row.study_date,
  }));
}

/**
 * The tier a value falls in. Bands are half-open — `lower <= value < upper` — with a null bound
 * meaning unbounded, so every value falls in exactly one tier and none falls between two.
 */
export function assignTier(
  metric: string,
  value: number | null,
  thresholds: readonly BenchmarkThreshold[],
): BenchmarkAssignment | null {
  const forMetric = thresholds.filter((threshold) => threshold.metric === metric);
  if (forMetric.length === 0) return null;

  const first = forMetric[0]!;
  const base = {
    metric,
    unit: first.unit,
    source: first.source,
    studyDate: first.studyDate,
    thresholds: forMetric,
  };

  if (value === null) {
    return { ...base, tier: null, lowerBound: null, upperBound: null };
  }

  const match = forMetric.find(
    (threshold) =>
      (threshold.lowerBound === null || value >= threshold.lowerBound) &&
      (threshold.upperBound === null || value < threshold.upperBound),
  );
  if (!match) return { ...base, tier: null, lowerBound: null, upperBound: null };

  return {
    ...base,
    tier: match.tier,
    lowerBound: match.lowerBound,
    upperBound: match.upperBound,
  };
}

/**
 * Tiers for a bucket's comparable metrics. Evaluated against p75, which is the aggregation the
 * published study states its bands in — comparing a median to a p75 band would flatter every team.
 */
export function assignTiers(
  values: Readonly<Record<string, number | null>>,
  thresholds: readonly BenchmarkThreshold[],
): Record<string, BenchmarkAssignment> {
  const assignments: Record<string, BenchmarkAssignment> = {};
  for (const [metric, value] of Object.entries(values)) {
    const assignment = assignTier(metric, value, thresholds);
    if (assignment) assignments[metric] = assignment;
  }
  return assignments;
}
