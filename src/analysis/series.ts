/**
 * The rollup layer (spec: metric-aggregation).
 *
 * Every chart and tile reads from here, so two surfaces showing the same metric cannot disagree.
 * Three properties shape the module:
 *
 * 1. **Computed on read.** There is no cached aggregate that can drift from the analysis row
 *    beneath it, and therefore no invalidation to get wrong (design.md D3). A definition change
 *    takes effect as soon as the rows beneath are recomputed.
 * 2. **Bucketing happens in the database, in the workspace's time zone.** Postgres does the
 *    calendar and daylight-saving arithmetic, so a bucket assignment is the same on every
 *    recomputation and does not depend on the server's locale.
 * 3. **There is still no function that orders contributors.** Contributor scope returns one
 *    contributor's own values, with no comparison set.
 */
import type { WorkspaceScope } from '../db/scope';
import { buildPredicate, type MetricScope } from './aggregate';
import { DEFAULT_METRIC_SETTINGS, type MetricSettings } from './settings';

export type Granularity = 'day' | 'week' | 'month';

/** The truncation unit and step Postgres uses for each granularity. */
const GRANULARITY_SQL: Record<Granularity, { trunc: string; step: string }> = {
  day: { trunc: 'day', step: "INTERVAL '1 day'" },
  week: { trunc: 'week', step: "INTERVAL '1 week'" },
  month: { trunc: 'month', step: "INTERVAL '1 month'" },
};

export const LATENCY_METRICS = [
  'cycle_time',
  'coding_time',
  'pickup_time',
  'review_time',
  'time_to_first_review',
  'time_to_approval',
  'time_to_merge_after_approval',
] as const;

export type LatencyMetric = (typeof LATENCY_METRICS)[number];

export interface DistributionSummary {
  p50: number | null;
  p75: number | null;
  p90: number | null;
  mean: number | null;
  /** Pull requests that contributed a value. */
  contributing: number;
  /** Pull requests in the bucket that lacked this metric. */
  excluded: number;
  /** True when the sample was too small to state percentiles from (spec: minimum sample size). */
  suppressed: boolean;
}

export interface ChurnSummary {
  newCodeLines: number;
  refactorLines: number;
  reworkLines: number;
  excludedLines: number;
  newCodeShare: number | null;
  refactorShare: number | null;
  reworkShare: number | null;
  contributing: number;
  excluded: number;
  /** Any contributing pull request whose rework leaned on the recency approximation (D2). */
  usedRecencyEstimate: boolean;
}

/** The precision the three churn shares are reported at, and the unit they are rounded in. */
const SHARE_UNITS = 1000;

/**
 * The three churn shares, rounded together rather than each on its own (design.md D4).
 *
 * `pr-metrics` requires that the three sum to the whole *at the precision they are reported in*,
 * so that a consumer may rely on the sum without re-deriving it from the line counts. Rounding
 * each independently does not preserve a sum — an even three-way split reports 0.333 three times
 * and loses a thousandth, and other splits gain one, which a chart scaled to the observed total
 * then reads as a ceiling of 2.
 *
 * Largest remainder distributes the leftover units to the components that were truncated hardest,
 * rather than deriving one component as `1 - a - b`: that would make one of the three the residual
 * that silently absorbs every rounding error, and rework — the benchmarked one — must not be the
 * place the drift lands.
 *
 * Absent stays absent: a bucket with no changed lines has no composition, not a zero one.
 */
export function churnShares(
  newCodeLines: number,
  refactorLines: number,
  reworkLines: number,
): { newCode: number | null; refactor: number | null; rework: number | null } {
  const parts = [newCodeLines, refactorLines, reworkLines];
  const total = parts.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { newCode: null, refactor: null, rework: null };

  const exact = parts.map((value) => (value / total) * SHARE_UNITS);
  const units = exact.map(Math.floor);
  let remaining = SHARE_UNITS - units.reduce((sum, value) => sum + value, 0);

  // Ties go to the earlier component, so the same line counts always report the same shares.
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const entry of byRemainder) {
    if (remaining <= 0) break;
    units[entry.index]! += 1;
    remaining -= 1;
  }

  return {
    newCode: units[0]! / SHARE_UNITS,
    refactor: units[1]! / SHARE_UNITS,
    rework: units[2]! / SHARE_UNITS,
  };
}

export interface MetricBucket {
  start: Date;
  end: Date;
  label: string;
  /** The bucket begins before the workspace's recorded coverage: empty is not the same as absent. */
  outsideCoverage: boolean;
  mergedCount: number;
  /** Prorated contributor-equivalents in scope for this bucket (design.md D4). */
  contributors: number;
  /** Merged pull requests per active contributor. Absent when the scope had none. */
  throughputPerContributor: number | null;
  /** The same figure per contributor per day — the unit the published benchmark is stated in. */
  throughputPerContributorDay: number | null;
  latency: Record<LatencyMetric, DistributionSummary>;
  size: DistributionSummary;
  churn: ChurnSummary | null;
  prMaturity: DistributionSummary;
  reviewDepth: DistributionSummary;
  /** Reachable default-branch commits in the bucket. */
  commits: number;
}

export interface SeriesOptions {
  granularity: Granularity;
  settings?: MetricSettings;
  /** Buckets beginning before this point are marked as outside coverage rather than empty. */
  coverageStart?: Date | null;
}

function bucketLabel(start: Date, granularity: Granularity, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions =
    granularity === 'month'
      ? { year: 'numeric', month: 'short', timeZone }
      : { year: 'numeric', month: 'short', day: 'numeric', timeZone };
  return new Intl.DateTimeFormat('en-GB', options).format(start);
}

function toNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
}

function summary(
  row: Record<string, number | string | null>,
  prefix: string,
  bucketTotal: number,
  minSampleSize: number,
): DistributionSummary {
  const contributing = Number(row[`${prefix}_count`] ?? 0);
  const suppressed = contributing > 0 && contributing < minSampleSize;
  const round = (value: number | null): number | null =>
    value === null ? null : Math.round(value * 1000) / 1000;

  return {
    // Percentiles from a handful of pull requests describe the handful, not the team, so they are
    // reported as absent while the count that would have produced them is still shown.
    p50: suppressed ? null : round(toNumber(row[`${prefix}_p50`] ?? null)),
    p75: suppressed ? null : round(toNumber(row[`${prefix}_p75`] ?? null)),
    p90: suppressed ? null : round(toNumber(row[`${prefix}_p90`] ?? null)),
    mean: round(toNumber(row[`${prefix}_mean`] ?? null)),
    contributing,
    excluded: Math.max(0, bucketTotal - contributing),
    suppressed,
  };
}

/** The percentile and mean fragment for one numeric column. */
function distributionSql(prefix: string, expression: string): string {
  return `
            percentile_cont(0.5) WITHIN GROUP (ORDER BY ${expression}) AS ${prefix}_p50,
            percentile_cont(0.75) WITHIN GROUP (ORDER BY ${expression}) AS ${prefix}_p75,
            percentile_cont(0.9) WITHIN GROUP (ORDER BY ${expression}) AS ${prefix}_p90,
            avg(${expression}) AS ${prefix}_mean,
            count(${expression})::int AS ${prefix}_count`;
}

/**
 * One value per period in the range, including periods with no activity — a gap in a chart has to
 * be distinguishable from a zero, and both from a period the data never covered.
 */
export async function metricSeries(
  scope: WorkspaceScope,
  filter: MetricScope,
  options: SeriesOptions,
): Promise<MetricBucket[]> {
  const settings = options.settings ?? DEFAULT_METRIC_SETTINGS;
  const { trunc, step } = GRANULARITY_SQL[options.granularity];

  const merged = buildPredicate(filter, { merged: true });
  const params = [...merged.params];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const tz = push(settings.timeZone);
  const rangeStart = push(filter.period.start);
  const rangeEnd = push(filter.period.end);

  const latencyColumns = LATENCY_METRICS.map((metric) =>
    distributionSql(metric, `r.${metric}_seconds`),
  ).join(',');

  const { rows } = await scope.query<Record<string, number | string | null> & {
    bucket_start: Date;
    bucket_end: Date;
  }>(
    `WITH buckets AS (
       SELECT gs AS bucket_local,
              gs AT TIME ZONE ${tz} AS bucket_start,
              (gs + ${step}) AT TIME ZONE ${tz} AS bucket_end
         FROM generate_series(
                date_trunc('${trunc}', ${rangeStart}::timestamptz AT TIME ZONE ${tz}),
                date_trunc('${trunc}', ${rangeEnd}::timestamptz AT TIME ZONE ${tz}),
                ${step}) gs
        WHERE gs AT TIME ZONE ${tz} < ${rangeEnd}::timestamptz
     ),
     rows AS (
       SELECT a.*,
              date_trunc('${trunc}', a.merged_at AT TIME ZONE ${tz}) AS bucket_local
         FROM pr_analysis a
        WHERE ${merged.sql}
     )
     SELECT b.bucket_start, b.bucket_end,
            count(r.pull_request_id)::int AS merged_count,
            count(DISTINCT r.author_contributor_id)::int AS distinct_authors,
            ${latencyColumns},
            ${distributionSql('size', 'COALESCE(r.additions, 0) + COALESCE(r.deletions, 0)')},
            ${distributionSql('maturity', 'r.pr_maturity')},
            ${distributionSql('depth', 'r.review_depth')},
            sum(r.new_code_lines)::int AS new_code_lines,
            sum(r.refactor_lines)::int AS refactor_lines,
            sum(r.rework_lines)::int AS rework_lines,
            sum(r.excluded_lines)::int AS churn_excluded_lines,
            count(r.new_code_lines)::int AS churn_count,
            bool_or(r.churn_used_recency_estimate) AS churn_estimated
       FROM buckets b
       LEFT JOIN rows r ON r.bucket_local = b.bucket_local
      GROUP BY b.bucket_start, b.bucket_end
      ORDER BY b.bucket_start`,
    params,
  );

  const denominators = await contributorDenominators(scope, filter, options);
  const commits = await commitCounts(scope, filter, options);

  return rows.map((row) => {
    const mergedCount = Number(row.merged_count ?? 0);
    const start = row.bucket_start;
    const end = row.bucket_end;
    const key = start.getTime();
    const contributors = denominators.get(key) ?? 0;
    const bucketDays = (end.getTime() - start.getTime()) / 86_400_000;

    const latency = Object.fromEntries(
      LATENCY_METRICS.map((metric) => [
        metric,
        summary(row, metric, mergedCount, settings.minSampleSize),
      ]),
    ) as Record<LatencyMetric, DistributionSummary>;

    const churnContributing = Number(row.churn_count ?? 0);
    const shares = churnShares(
      Number(row.new_code_lines ?? 0),
      Number(row.refactor_lines ?? 0),
      Number(row.rework_lines ?? 0),
    );

    return {
      start,
      end,
      label: bucketLabel(start, options.granularity, settings.timeZone),
      outsideCoverage:
        options.coverageStart !== undefined &&
        options.coverageStart !== null &&
        start < options.coverageStart,
      mergedCount,
      contributors: Math.round(contributors * 1000) / 1000,
      // Absent, not zero: a scope with no active contributors has no rate to state.
      throughputPerContributor:
        contributors > 0 ? Math.round((mergedCount / contributors) * 1000) / 1000 : null,
      throughputPerContributorDay:
        contributors > 0 && bucketDays > 0
          ? Math.round((mergedCount / contributors / bucketDays) * 1000) / 1000
          : null,
      latency,
      size: summary(row, 'size', mergedCount, settings.minSampleSize),
      prMaturity: summary(row, 'maturity', mergedCount, settings.minSampleSize),
      reviewDepth: summary(row, 'depth', mergedCount, settings.minSampleSize),
      churn:
        churnContributing === 0
          ? null
          : {
              newCodeLines: Number(row.new_code_lines ?? 0),
              refactorLines: Number(row.refactor_lines ?? 0),
              reworkLines: Number(row.rework_lines ?? 0),
              excludedLines: Number(row.churn_excluded_lines ?? 0),
              newCodeShare: shares.newCode,
              refactorShare: shares.refactor,
              reworkShare: shares.rework,
              contributing: churnContributing,
              excluded: Math.max(0, mergedCount - churnContributing),
              usedRecencyEstimate: Boolean(row.churn_estimated),
            },
      commits: commits.get(key) ?? 0,
    };
  });
}

export interface WorkMixBucket {
  start: Date;
  end: Date;
  label: string;
  /** Merged pull requests carrying a classification above the confidence threshold. */
  classified: number;
  /** Merged pull requests with no usable classification — reported, never counted as a type. */
  unclassified: number;
  byType: Record<string, number>;
  /** Share of classified pull requests that are bug fixes. Absent when none are classified. */
  defectRatio: number | null;
  /** Share that are features. */
  innovationRatio: number | null;
}

/**
 * Mix-of-work ratios (spec: work-classification "Mix-of-work ratios are derived from
 * classifications").
 *
 * Computed over the classified subset only, with the unclassified count reported alongside, so a
 * partially classified period is visibly partial rather than quietly wrong. A bucket with nothing
 * classified has absent ratios — not zero, which would read as "no bugs this week".
 */
export async function workMixSeries(
  scope: WorkspaceScope,
  filter: MetricScope,
  options: SeriesOptions & { confidenceThreshold?: number },
): Promise<WorkMixBucket[]> {
  const settings = options.settings ?? DEFAULT_METRIC_SETTINGS;
  const { trunc, step } = GRANULARITY_SQL[options.granularity];
  const merged = buildPredicate(filter, { merged: true });

  const params = [...merged.params];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const tz = push(settings.timeZone);
  const rangeStart = push(filter.period.start);
  const rangeEnd = push(filter.period.end);
  const threshold = push(options.confidenceThreshold ?? 0);

  const { rows } = await scope.query<{
    bucket_start: Date;
    bucket_end: Date;
    classified: number;
    total: number;
    work_type: string | null;
    type_count: number;
  }>(
    `WITH buckets AS (
       SELECT gs AS bucket_local,
              gs AT TIME ZONE ${tz} AS bucket_start,
              (gs + ${step}) AT TIME ZONE ${tz} AS bucket_end
         FROM generate_series(
                date_trunc('${trunc}', ${rangeStart}::timestamptz AT TIME ZONE ${tz}),
                date_trunc('${trunc}', ${rangeEnd}::timestamptz AT TIME ZONE ${tz}),
                ${step}) gs
        WHERE gs AT TIME ZONE ${tz} < ${rangeEnd}::timestamptz
     ),
     rows AS (
       SELECT date_trunc('${trunc}', a.merged_at AT TIME ZONE ${tz}) AS bucket_local,
              -- A below-threshold classification is stored and shown on the pull request, but is
              -- unclassified for the purpose of a ratio (spec: low-confidence scenario).
              CASE WHEN k.status = 'classified' AND k.confidence >= ${threshold}
                   THEN k.work_type END AS work_type
         FROM pr_analysis a
         LEFT JOIN pr_classifications k
           ON k.workspace_id = a.workspace_id AND k.pull_request_id = a.pull_request_id
        WHERE ${merged.sql}
     )
     SELECT b.bucket_start, b.bucket_end,
            count(r.work_type)::int AS classified,
            count(r.bucket_local)::int AS total,
            r.work_type,
            count(r.work_type)::int AS type_count
       FROM buckets b LEFT JOIN rows r ON r.bucket_local = b.bucket_local
      GROUP BY b.bucket_start, b.bucket_end, r.work_type
      ORDER BY b.bucket_start`,
    params,
  );

  const buckets = new Map<number, WorkMixBucket>();
  const totals = new Map<number, number>();
  for (const row of rows) {
    const key = row.bucket_start.getTime();
    if (!buckets.has(key)) {
      buckets.set(key, {
        start: row.bucket_start,
        end: row.bucket_end,
        label: bucketLabel(row.bucket_start, options.granularity, settings.timeZone),
        classified: 0,
        unclassified: 0,
        byType: {},
        defectRatio: null,
        innovationRatio: null,
      });
    }
    const bucket = buckets.get(key)!;
    // One row per (bucket, work type), including the null-type group, so the bucket's total is
    // the sum across its groups rather than any single one of them.
    totals.set(key, (totals.get(key) ?? 0) + row.total);
    if (row.work_type !== null) {
      bucket.byType[row.work_type] = (bucket.byType[row.work_type] ?? 0) + row.type_count;
      bucket.classified += row.type_count;
    }
  }

  for (const [key, bucket] of buckets) {
    bucket.unclassified = Math.max(0, (totals.get(key) ?? 0) - bucket.classified);
    if (bucket.classified === 0) continue;
    const share = (count: number): number =>
      Math.round((count / bucket.classified) * 1000) / 1000;
    bucket.defectRatio = share(bucket.byType.bug_fix ?? 0);
    bucket.innovationRatio = share(bucket.byType.feature ?? 0);
  }

  return [...buckets.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

export interface HistogramBin {
  label: string;
  /** Half-open, in the metric's own unit: `lower <= value < upper`. Null upper is unbounded. */
  lower: number;
  upper: number | null;
  count: number;
}

export interface Histogram {
  bins: HistogramBin[];
  summary: DistributionSummary;
}

/** Size bands in lines changed, and latency bands in seconds. */
export const SIZE_BINS = [0, 10, 50, 100, 250, 500, 1000];
export const LATENCY_BINS = [0, 3600, 4 * 3600, 24 * 3600, 3 * 24 * 3600, 7 * 24 * 3600];

/**
 * The shape of a metric over the whole period, for the surfaces that replace a single number with
 * a distribution. A p75 beside a mean says how skewed the tail is; a histogram shows where it is.
 */
export async function metricDistribution(
  scope: WorkspaceScope,
  filter: MetricScope,
  options: {
    metric: LatencyMetric | 'size';
    bins?: readonly number[];
    settings?: MetricSettings;
  },
): Promise<Histogram> {
  const settings = options.settings ?? DEFAULT_METRIC_SETTINGS;
  const edges = [...(options.bins ?? (options.metric === 'size' ? SIZE_BINS : LATENCY_BINS))];
  const expression =
    options.metric === 'size'
      ? 'COALESCE(a.additions, 0) + COALESCE(a.deletions, 0)'
      : `a.${options.metric}_seconds`;

  const predicate = buildPredicate(filter, { merged: true });
  const params = [...predicate.params];
  const binCases = edges
    .map((lower, index) => {
      const upper = edges[index + 1];
      const bound = upper === undefined ? '' : ` AND ${expression} < ${upper}`;
      return `count(*) FILTER (WHERE ${expression} >= ${lower}${bound})::int AS bin_${index}`;
    })
    .join(',\n            ');

  const { rows } = await scope.query<Record<string, number | string | null>>(
    `SELECT ${binCases},
            count(*)::int AS total,
            ${distributionSql('value', expression).replaceAll('r.', 'a.')}
       FROM pr_analysis a
      WHERE ${predicate.sql}`,
    params,
  );

  const row = rows[0]!;
  const total = Number(row.total ?? 0);
  return {
    bins: edges.map((lower, index) => {
      const upper = edges[index + 1] ?? null;
      return {
        lower,
        upper,
        label: upper === null ? `${lower}+` : `${lower}–${upper}`,
        count: Number(row[`bin_${index}`] ?? 0),
      };
    }),
    summary: summary(row, 'value', total, settings.minSampleSize),
  };
}

/**
 * Contributor-days per bucket, from the membership interval tables (design.md D4).
 *
 * A contributor counts for the fraction of the bucket they were a member of the scope, so a join,
 * a departure, or a move between teams mid-bucket splits them across the buckets and scopes they
 * actually belonged to rather than distorting a rate.
 */
export async function contributorDenominators(
  scope: WorkspaceScope,
  filter: MetricScope,
  options: SeriesOptions,
): Promise<Map<number, number>> {
  const settings = options.settings ?? DEFAULT_METRIC_SETTINGS;
  const { trunc, step } = GRANULARITY_SQL[options.granularity];

  const params: unknown[] = [];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const tz = push(settings.timeZone);
  const rangeStart = push(filter.period.start);
  const rangeEnd = push(filter.period.end);

  // Team scope reads the team's own intervals; workspace and contributor scope read the
  // workspace's. Both tables carry the same shape, so the overlap arithmetic is written once.
  const teamId = filter.teamId ? push(filter.teamId) : null;
  const contributorId = filter.contributorId ? push(filter.contributorId) : null;
  const membership = teamId
    ? `SELECT m.contributor_id, m.started_at, m.ended_at
         FROM team_memberships m
        WHERE m.workspace_id = :workspace AND m.team_id = ${teamId}`
    : `SELECT m.contributor_id, m.started_at, m.ended_at
         FROM workspace_memberships m
        WHERE m.workspace_id = :workspace
          ${contributorId ? `AND m.contributor_id = ${contributorId}` : ''}
          ${
            filter.unassignedOnly
              ? `AND NOT EXISTS (SELECT 1 FROM team_members tm
                                  WHERE tm.workspace_id = m.workspace_id
                                    AND tm.contributor_id = m.contributor_id)`
              : ''
          }`;

  const { rows } = await scope.query<{ bucket_start: Date; contributors: string | number }>(
    `WITH buckets AS (
       SELECT gs AT TIME ZONE ${tz} AS bucket_start,
              (gs + ${step}) AT TIME ZONE ${tz} AS bucket_end
         FROM generate_series(
                date_trunc('${trunc}', ${rangeStart}::timestamptz AT TIME ZONE ${tz}),
                date_trunc('${trunc}', ${rangeEnd}::timestamptz AT TIME ZONE ${tz}),
                ${step}) gs
        WHERE gs AT TIME ZONE ${tz} < ${rangeEnd}::timestamptz
     ),
     memberships AS (${membership})
     SELECT b.bucket_start,
            COALESCE(
              (sum(
                 GREATEST(0, EXTRACT(EPOCH FROM (
                   LEAST(COALESCE(m.ended_at, b.bucket_end), b.bucket_end)
                   - GREATEST(m.started_at, b.bucket_start)
                 )))
               ) FILTER (WHERE m.contributor_id IS NOT NULL AND c.id IS NOT NULL))
              / NULLIF(EXTRACT(EPOCH FROM (b.bucket_end - b.bucket_start)), 0),
            0) AS contributors
       FROM buckets b
       -- A bucket with no overlapping membership must yield zero, not a whole bucket: Postgres's
       -- GREATEST and LEAST ignore NULLs, so the unmatched side of the join is filtered out of the
       -- sum explicitly rather than left to arithmetic.
       LEFT JOIN memberships m
         ON m.started_at < b.bucket_end
        AND (m.ended_at IS NULL OR m.ended_at > b.bucket_start)
       LEFT JOIN contributors c ON c.id = m.contributor_id AND c.is_bot = false
      GROUP BY b.bucket_start, b.bucket_end
      ORDER BY b.bucket_start`,
    params,
  );

  return new Map(rows.map((row) => [row.bucket_start.getTime(), Number(row.contributors ?? 0)]));
}

/** Reachable default-branch commits per bucket (spec: "Commit activity is requested"). */
export async function commitCounts(
  scope: WorkspaceScope,
  filter: MetricScope,
  options: SeriesOptions,
): Promise<Map<number, number>> {
  const settings = options.settings ?? DEFAULT_METRIC_SETTINGS;
  const { trunc, step } = GRANULARITY_SQL[options.granularity];

  const params: unknown[] = [];
  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const tz = push(settings.timeZone);
  const rangeStart = push(filter.period.start);
  const rangeEnd = push(filter.period.end);
  const repositories = push([...filter.repositoryIds]);
  const contributorId = filter.contributorId ? push(filter.contributorId) : null;
  const teamId = filter.teamId ? push(filter.teamId) : null;

  const { rows } = await scope.query<{ bucket_start: Date; commits: number }>(
    `WITH buckets AS (
       SELECT gs AS bucket_local,
              gs AT TIME ZONE ${tz} AS bucket_start
         FROM generate_series(
                date_trunc('${trunc}', ${rangeStart}::timestamptz AT TIME ZONE ${tz}),
                date_trunc('${trunc}', ${rangeEnd}::timestamptz AT TIME ZONE ${tz}),
                ${step}) gs
        WHERE gs AT TIME ZONE ${tz} < ${rangeEnd}::timestamptz
     ),
     rows AS (
       SELECT date_trunc('${trunc}', rc.committed_at AT TIME ZONE ${tz}) AS bucket_local
         FROM repository_commits rc
         LEFT JOIN contributors c ON c.id = rc.author_contributor_id
        WHERE rc.workspace_id = :workspace
          AND rc.reachable = true
          AND rc.repository_id = ANY(${repositories}::uuid[])
          AND rc.committed_at >= ${rangeStart}
          AND rc.committed_at < ${rangeEnd}
          AND COALESCE(c.is_bot, false) = false
          ${contributorId ? `AND rc.author_contributor_id = ${contributorId}` : ''}
          ${
            teamId
              ? `AND EXISTS (SELECT 1 FROM team_members tm
                              WHERE tm.workspace_id = rc.workspace_id
                                AND tm.contributor_id = rc.author_contributor_id
                                AND tm.team_id = ${teamId})`
              : ''
          }
     )
     SELECT b.bucket_start, count(r.bucket_local)::int AS commits
       FROM buckets b LEFT JOIN rows r ON r.bucket_local = b.bucket_local
      GROUP BY b.bucket_start
      ORDER BY b.bucket_start`,
    params,
  );

  return new Map(rows.map((row) => [row.bucket_start.getTime(), row.commits]));
}
