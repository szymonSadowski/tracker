/**
 * Aggregate queries over the derived layer (spec: analytics-dashboard, pr-metrics).
 *
 * Two rules shape everything here:
 *
 * 1. Absent values are excluded from aggregates and the aggregate reports its own coverage, so a
 *    median over 4 of 30 pull requests can never be read as a median over 30 (design.md D6).
 * 2. There is no function that orders contributors by a throughput or latency metric, and none
 *    that reports a latency, size, or churn metric per person on a team-scoped surface. That is
 *    the enforcement of design.md D10 — a ranking cannot be built from this module. The single
 *    per-person comparison the product offers is `contributorThroughputSeries` in `series.ts`:
 *    merged counts only, in name order (D10 as amended by `add-per-author-throughput`).
 */
import type { WorkspaceScope } from '../db/scope';
import type { SizeBucket } from './metrics';

export interface Period {
  start: Date;
  end: Date;
  label: string;
}

export function periodOfDays(days: number, now: Date = new Date()): Period {
  return {
    start: new Date(now.getTime() - days * 24 * 3600_000),
    end: now,
    label: `Last ${days} days`,
  };
}

/**
 * A chart bucket's own window, as carried in a drill-through link. Returns undefined for anything
 * malformed, so a hand-edited URL falls back to the selected period rather than erroring.
 */
export function parseBucketWindow(
  from: string | undefined,
  to: string | undefined,
): Period | undefined {
  if (!from || !to) return undefined;
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return undefined;
  }
  return {
    start,
    end,
    label: `${start.toISOString().slice(0, 10)} to ${end.toISOString().slice(0, 10)}`,
  };
}

/** The period immediately before `period`, for a trend against one's own previous period. */
export function previousPeriod(period: Period): Period {
  const span = period.end.getTime() - period.start.getTime();
  return {
    start: new Date(period.start.getTime() - span),
    end: period.start,
    label: `Previous ${Math.round(span / (24 * 3600_000))} days`,
  };
}

export interface MetricScope {
  period: Period;
  /** Repositories the viewer may see — access control is applied before aggregation (D8). */
  repositoryIds: readonly string[];
  teamId?: string | null;
  /** Contributors with no team assignment. Mutually exclusive with teamId. */
  unassignedOnly?: boolean;
  contributorId?: string;
  includeBots?: boolean;
}

export interface MetricSummary {
  /** Seconds. Null when no pull request in scope had a computable value. */
  median: number | null;
  p75: number | null;
  /** How many pull requests contributed a value, out of how many were in scope. */
  covered: number;
  total: number;
}

export interface TeamMetrics {
  mergedCount: number;
  openedCount: number;
  cycleTime: MetricSummary;
  timeToFirstReview: MetricSummary;
  timeToApproval: MetricSummary;
  sizeDistribution: Record<SizeBucket, number>;
  medianReviewCycles: number | null;
  contributors: number;
}

export interface Predicate {
  sql: string;
  params: unknown[];
}

/**
 * One predicate builder shared by the aggregates and by the drill-through list, so the list can
 * be exactly the set the aggregate was computed from (spec: analytics-dashboard).
 */
export function buildPredicate(scope: MetricScope, options: { merged: boolean }): Predicate {
  const params: unknown[] = [];
  const clauses = ['a.workspace_id = :workspace'];

  const push = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (scope.repositoryIds.length === 0) {
    // No visible repository: an empty set, expressed so the query still runs.
    clauses.push('false');
  } else {
    clauses.push(`a.repository_id = ANY(${push([...scope.repositoryIds])}::uuid[])`);
  }

  if (options.merged) {
    clauses.push('a.merged_at IS NOT NULL');
    clauses.push(`a.merged_at >= ${push(scope.period.start)}`);
    clauses.push(`a.merged_at < ${push(scope.period.end)}`);
  } else {
    clauses.push(`a.opened_at >= ${push(scope.period.start)}`);
    clauses.push(`a.opened_at < ${push(scope.period.end)}`);
  }

  if (!scope.includeBots) clauses.push('a.author_is_bot = false');

  if (scope.contributorId) {
    clauses.push(`a.author_contributor_id = ${push(scope.contributorId)}`);
  }

  if (scope.teamId) {
    /**
     * Attribution follows the membership interval the pull request falls in, so someone who moved
     * teams mid-period takes their earlier work with them rather than backdating all of it to
     * where they ended up (spec: "attributed to the team they belonged to on the merge date").
     *
     * The earliest interval is treated as reaching back indefinitely: a first assignment says who
     * someone is, and would otherwise silently drop every pull request they merged before an
     * owner got round to filling in the roster.
     */
    clauses.push(
      `EXISTS (SELECT 1 FROM team_memberships tm
                WHERE tm.workspace_id = a.workspace_id
                  AND tm.contributor_id = a.author_contributor_id
                  AND tm.team_id = ${push(scope.teamId)}
                  AND (COALESCE(a.merged_at, a.opened_at) >= tm.started_at
                       OR NOT EXISTS (SELECT 1 FROM team_memberships earlier
                                       WHERE earlier.workspace_id = tm.workspace_id
                                         AND earlier.contributor_id = tm.contributor_id
                                         AND earlier.started_at < tm.started_at))
                  AND (tm.ended_at IS NULL
                       OR COALESCE(a.merged_at, a.opened_at) < tm.ended_at))`,
    );
  } else if (scope.unassignedOnly) {
    clauses.push(
      `NOT EXISTS (SELECT 1 FROM team_members tm
                    WHERE tm.workspace_id = a.workspace_id
                      AND tm.contributor_id = a.author_contributor_id)`,
    );
  }

  return { sql: clauses.join('\n           AND '), params };
}

function summary(row: {
  median: number | null;
  p75: number | null;
  covered: number;
  total: number;
}): MetricSummary {
  return {
    median: row.median === null ? null : Math.round(row.median),
    p75: row.p75 === null ? null : Math.round(row.p75),
    covered: row.covered,
    total: row.total,
  };
}

export async function teamMetrics(
  scope: WorkspaceScope,
  filter: MetricScope,
): Promise<TeamMetrics> {
  const merged = buildPredicate(filter, { merged: true });
  const opened = buildPredicate(filter, { merged: false });

  const { rows } = await scope.query<{
    merged_count: number;
    contributors: number;
    cycle_median: number | null;
    cycle_p75: number | null;
    cycle_covered: number;
    review_median: number | null;
    review_p75: number | null;
    review_covered: number;
    approval_median: number | null;
    approval_p75: number | null;
    approval_covered: number;
    review_cycles_median: number | null;
    xs: number;
    s: number;
    m: number;
    l: number;
    xl: number;
  }>(
    `SELECT count(*)::int AS merged_count,
            count(DISTINCT a.author_contributor_id)::int AS contributors,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY a.cycle_time_seconds) AS cycle_median,
            percentile_cont(0.75) WITHIN GROUP (ORDER BY a.cycle_time_seconds) AS cycle_p75,
            count(a.cycle_time_seconds)::int AS cycle_covered,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY a.time_to_first_review_seconds) AS review_median,
            percentile_cont(0.75) WITHIN GROUP (ORDER BY a.time_to_first_review_seconds) AS review_p75,
            count(a.time_to_first_review_seconds)::int AS review_covered,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY a.time_to_approval_seconds) AS approval_median,
            percentile_cont(0.75) WITHIN GROUP (ORDER BY a.time_to_approval_seconds) AS approval_p75,
            count(a.time_to_approval_seconds)::int AS approval_covered,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY a.review_cycles) AS review_cycles_median,
            count(*) FILTER (WHERE a.size_bucket = 'xs')::int AS xs,
            count(*) FILTER (WHERE a.size_bucket = 's')::int AS s,
            count(*) FILTER (WHERE a.size_bucket = 'm')::int AS m,
            count(*) FILTER (WHERE a.size_bucket = 'l')::int AS l,
            count(*) FILTER (WHERE a.size_bucket = 'xl')::int AS xl
       FROM pr_analysis a
      WHERE ${merged.sql}`,
    merged.params,
  );

  const openedRow = await scope.query<{ opened_count: number }>(
    `SELECT count(*)::int AS opened_count FROM pr_analysis a WHERE ${opened.sql}`,
    opened.params,
  );

  const row = rows[0]!;
  const total = row.merged_count;

  return {
    mergedCount: row.merged_count,
    openedCount: openedRow.rows[0]!.opened_count,
    contributors: row.contributors,
    cycleTime: summary({
      median: row.cycle_median,
      p75: row.cycle_p75,
      covered: row.cycle_covered,
      total,
    }),
    timeToFirstReview: summary({
      median: row.review_median,
      p75: row.review_p75,
      covered: row.review_covered,
      total,
    }),
    timeToApproval: summary({
      median: row.approval_median,
      p75: row.approval_p75,
      covered: row.approval_covered,
      total,
    }),
    medianReviewCycles:
      row.review_cycles_median === null ? null : Number(row.review_cycles_median.toFixed(1)),
    sizeDistribution: { xs: row.xs, s: row.s, m: row.m, l: row.l, xl: row.xl },
  };
}

export interface PullRequestListItem {
  id: string;
  number: number;
  title: string;
  url: string | null;
  state: string;
  repositoryFullName: string;
  authorLogin: string | null;
  authorContributorId: string | null;
  mergedAt: Date | null;
  openedAt: Date;
  cycleTimeSeconds: number | null;
  timeToFirstReviewSeconds: number | null;
  additions: number | null;
  deletions: number | null;
  filesChanged: number | null;
  sizeBucket: SizeBucket | null;
}

/**
 * The pull requests behind a metric. Called with the same `MetricScope` the aggregate used, it
 * returns exactly that input set.
 */
export async function listPullRequests(
  scope: WorkspaceScope,
  filter: MetricScope,
  options: {
    merged?: boolean;
    limit?: number;
    state?: 'open' | 'closed' | 'merged';
    /** Narrows to one classified work type, for a work-mix segment drill-through. */
    workType?: string;
  } = {},
): Promise<PullRequestListItem[]> {
  const predicate = buildPredicate(filter, { merged: options.merged ?? true });
  const params = [...predicate.params];
  let extra = '';
  if (options.state) {
    params.push(options.state);
    extra = ` AND a.pr_state = $${params.length}`;
  }
  if (options.workType) {
    params.push(options.workType);
    extra += ` AND EXISTS (SELECT 1 FROM pr_classifications k
                            WHERE k.workspace_id = a.workspace_id
                              AND k.pull_request_id = a.pull_request_id
                              AND k.status = 'classified'
                              AND k.work_type = $${params.length})`;
  }
  params.push(options.limit ?? 200);
  const limitParam = `$${params.length}`;

  const { rows } = await scope.query<{
    id: string;
    number: number;
    title: string;
    url: string | null;
    state: string;
    repository_full_name: string;
    author_login: string | null;
    author_contributor_id: string | null;
    merged_at: Date | null;
    opened_at: Date;
    cycle_time_seconds: number | null;
    time_to_first_review_seconds: number | null;
    additions: number | null;
    deletions: number | null;
    files_changed: number | null;
    size_bucket: SizeBucket | null;
  }>(
    `SELECT pr.id, pr.number, pr.title, pr.url, pr.state,
            r.full_name AS repository_full_name,
            c.login AS author_login,
            a.author_contributor_id, a.merged_at, a.opened_at,
            a.cycle_time_seconds, a.time_to_first_review_seconds,
            a.additions, a.deletions, a.files_changed, a.size_bucket
       FROM pr_analysis a
       JOIN pull_requests pr ON pr.id = a.pull_request_id
       JOIN repositories r ON r.id = a.repository_id
       LEFT JOIN contributors c ON c.id = a.author_contributor_id
      WHERE ${predicate.sql}${extra}
      ORDER BY COALESCE(a.merged_at, a.opened_at) DESC
      LIMIT ${limitParam}`,
    params,
  );

  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    title: row.title,
    url: row.url,
    state: row.state,
    repositoryFullName: row.repository_full_name,
    authorLogin: row.author_login,
    authorContributorId: row.author_contributor_id,
    mergedAt: row.merged_at,
    openedAt: row.opened_at,
    cycleTimeSeconds: row.cycle_time_seconds,
    timeToFirstReviewSeconds: row.time_to_first_review_seconds,
    additions: row.additions,
    deletions: row.deletions,
    filesChanged: row.files_changed,
    sizeBucket: row.size_bucket,
  }));
}

/**
 * Activity by contributors with no team assignment, so a team view can say plainly that its
 * totals do not include it (spec: tenancy-and-teams).
 */
export async function unassignedActivity(
  scope: WorkspaceScope,
  filter: Omit<MetricScope, 'teamId' | 'unassignedOnly'>,
): Promise<{ mergedCount: number; contributors: number }> {
  const predicate = buildPredicate({ ...filter, unassignedOnly: true }, { merged: true });
  const { rows } = await scope.query<{ merged_count: number; contributors: number }>(
    `SELECT count(*)::int AS merged_count,
            count(DISTINCT a.author_contributor_id)::int AS contributors
       FROM pr_analysis a
      WHERE ${predicate.sql}`,
    predicate.params,
  );
  return { mergedCount: rows[0]!.merged_count, contributors: rows[0]!.contributors };
}
