/**
 * The chart suite the team and personal views share (spec: analytics-dashboard).
 *
 * Every chart here reads the same rollup layer the headline tiles read, so a tile and the chart
 * beside it cannot disagree. Each one carries its own honesty: buckets outside coverage are
 * hatched and named, absent values are gaps, and a decomposition says how much of the bucket it
 * actually accounts for.
 */
import type { ReactNode } from 'react';
import {
  BenchmarkTier,
  HistogramChart,
  LineChart,
  StackedBarChart,
  type ChartPoint,
  type ChartSeries,
} from './charts';
import { formatCount, formatDuration, formatNumber, UNAVAILABLE } from './format';
import type { BenchmarkAssignment } from '../analysis/benchmarks';
import type { Histogram, MetricBucket, WorkMixBucket } from '../analysis/series';

const formatShare = (value: number | null): string =>
  value === null ? UNAVAILABLE : `${Math.round(value * 100)}%`;

const formatLines = (value: number | null): string =>
  value === null ? UNAVAILABLE : `${value.toLocaleString('en-GB')} lines`;

/** The bucket's slice of the pull request list, so a point on a chart leads to its pull requests. */
function bucketHref(base: string, bucket: MetricBucket): string {
  return `${base}${base.includes('?') ? '&' : '?'}from=${bucket.start.toISOString()}&to=${bucket.end.toISOString()}`;
}

function toPoints(
  buckets: readonly MetricBucket[],
  value: (bucket: MetricBucket) => number | null,
  drillThrough?: string,
): ChartPoint[] {
  return buckets.map((bucket) => ({
    label: bucket.label,
    value: bucket.outsideCoverage ? null : value(bucket),
    uncovered: bucket.outsideCoverage,
    href: drillThrough ? bucketHref(drillThrough, bucket) : undefined,
  }));
}

export interface MetricChartsProps {
  buckets: readonly MetricBucket[];
  drillThrough?: string;
  /** Assignments keyed by metric name, from `assignTiers`. */
  benchmarks?: Record<string, BenchmarkAssignment>;
  /** From when per-file diff data exists, for the churn chart's own coverage statement. */
  churnCoveredFrom?: Date | null;
  /** Absolute line counts rather than shares on the churn chart. */
  churnAbsolute?: boolean;
  churnToggleHref?: string;
}

/** Throughput, with its benchmark tier stated in the unit the study publishes. */
export function ThroughputChart({
  buckets,
  drillThrough,
  benchmark,
}: {
  buckets: readonly MetricBucket[];
  drillThrough?: string;
  benchmark?: BenchmarkAssignment;
}) {
  return (
    <LineChart
      title="PR throughput per contributor"
      description="Merged pull requests divided by the prorated contributors in scope."
      series={[
        {
          name: 'Per contributor',
          points: toPoints(buckets, (bucket) => bucket.throughputPerContributor, drillThrough),
        },
      ]}
      format={(value) => (value === null ? UNAVAILABLE : formatNumber(value, 2))}
      note={
        benchmark ? (
          <BenchmarkTier
            tier={benchmark.tier}
            lowerBound={benchmark.lowerBound}
            upperBound={benchmark.upperBound}
            source={benchmark.source}
            format={(value) => (value === null ? '—' : `${formatNumber(value, 2)}/day`)}
          />
        ) : null
      }
    />
  );
}

/**
 * Cycle time as its phases. Each bucket states how many of its pull requests the decomposition
 * covers, so a bucket where most pull requests lack a coding time does not read as one where
 * coding was fast (spec: "A phase is uncomputable for part of the period").
 */
export function CycleTimePhaseChart({
  buckets,
  drillThrough,
  benchmark,
}: {
  buckets: readonly MetricBucket[];
  drillThrough?: string;
  benchmark?: BenchmarkAssignment;
}) {
  const series: ChartSeries[] = [
    {
      name: 'Coding time',
      points: toPoints(buckets, (bucket) => bucket.latency.coding_time.p50, drillThrough),
    },
    {
      name: 'Pickup time',
      points: toPoints(buckets, (bucket) => bucket.latency.pickup_time.p50, drillThrough),
    },
    {
      name: 'Review time',
      points: toPoints(buckets, (bucket) => bucket.latency.review_time.p50, drillThrough),
    },
  ];

  const covered = buckets.reduce((sum, bucket) => sum + bucket.latency.coding_time.contributing, 0);
  const total = buckets.reduce((sum, bucket) => sum + bucket.mergedCount, 0);

  return (
    <StackedBarChart
      title="Cycle time by phase"
      description="Median coding, pickup, and review time, stacked to the bucket's cycle time."
      series={series}
      format={formatDuration}
      note={
        <>
          The decomposition covers {covered} of {total} merged pull requests; a phase without an
          anchor is left out rather than drawn as zero.{' '}
          {benchmark ? (
            <BenchmarkTier
              tier={benchmark.tier}
              lowerBound={benchmark.lowerBound}
              upperBound={benchmark.upperBound}
              source={benchmark.source}
              format={formatDuration}
            />
          ) : null}
        </>
      }
    />
  );
}

/**
 * Churn composition. Shares by default because the question is usually "what kind of work is
 * this", with absolute line counts a toggle away for when the question is "how much".
 */
export function ChurnChart({
  buckets,
  drillThrough,
  absolute = false,
  toggleHref,
  coveredFrom,
  reworkThreshold,
}: {
  buckets: readonly MetricBucket[];
  drillThrough?: string;
  absolute?: boolean;
  toggleHref?: string;
  coveredFrom?: Date | null;
  /** The needs-focus rework threshold, so a bucket above it can be marked against it. */
  reworkThreshold?: number | null;
}) {
  const pick = (
    lines: (bucket: MetricBucket) => number | null,
    share: (bucket: MetricBucket) => number | null,
  ) => (absolute ? lines : share);

  const series: ChartSeries[] = [
    {
      name: 'New code',
      points: toPoints(
        buckets,
        pick(
          (bucket) => bucket.churn?.newCodeLines ?? null,
          (bucket) => bucket.churn?.newCodeShare ?? null,
        ),
        drillThrough,
      ),
    },
    {
      name: 'Refactor',
      points: toPoints(
        buckets,
        pick(
          (bucket) => bucket.churn?.refactorLines ?? null,
          (bucket) => bucket.churn?.refactorShare ?? null,
        ),
        drillThrough,
      ),
    },
    {
      name: 'Rework',
      points: toPoints(
        buckets,
        pick(
          (bucket) => bucket.churn?.reworkLines ?? null,
          (bucket) => bucket.churn?.reworkShare ?? null,
        ),
        drillThrough,
      ),
    },
  ];

  const overThreshold =
    reworkThreshold === null || reworkThreshold === undefined
      ? []
      : buckets.filter((bucket) => (bucket.churn?.reworkShare ?? 0) >= reworkThreshold);
  const estimated = buckets.some((bucket) => bucket.churn?.usedRecencyEstimate);

  return (
    <StackedBarChart
      title={absolute ? 'Code churn (lines)' : 'Code churn (share)'}
      description="New code, refactor, and rework per bucket."
      series={series}
      format={absolute ? formatLines : formatShare}
      note={
        <>
          {coveredFrom ? (
            <>Per-file diff data exists from {coveredFrom.toISOString().slice(0, 10)} onwards. </>
          ) : null}
          {overThreshold.length > 0 ? (
            <>
              {overThreshold.length} bucket(s) at or above the needs-focus rework threshold of{' '}
              {formatShare(reworkThreshold ?? null)}:{' '}
              {overThreshold.map((bucket) => bucket.label).join(', ')}.{' '}
            </>
          ) : null}
          {estimated ? (
            <>
              Some rework here used the file-level recency approximation rather than the exact
              post-review component.{' '}
            </>
          ) : null}
          {toggleHref ? <a href={toggleHref}>Show {absolute ? 'shares' : 'line counts'}</a> : null}
        </>
      }
    />
  );
}

export function CommitActivityChart({
  buckets,
  filterNote,
}: {
  buckets: readonly MetricBucket[];
  filterNote?: ReactNode;
}) {
  return (
    <LineChart
      title="Commit activity"
      description="Reachable commits on each repository's default branch, independent of pull requests."
      series={[{ name: 'Commits', points: toPoints(buckets, (bucket) => bucket.commits) }]}
      format={formatCount}
      note={filterNote}
    />
  );
}

/** A distribution with its percentile summary, and an explicit too-small-sample state. */
export function DistributionView({
  title,
  description,
  histogram,
  format,
}: {
  title: string;
  description?: string;
  histogram: Histogram;
  format: (value: number | null) => string;
}) {
  return (
    <HistogramChart
      title={title}
      description={description}
      bins={histogram.bins.map((bin) => ({ label: bin.label, count: bin.count }))}
      tooSmall={histogram.summary.suppressed}
      note={
        histogram.summary.suppressed ? null : (
          <>
            p50 {format(histogram.summary.p50)} · p75 {format(histogram.summary.p75)} · p90{' '}
            {format(histogram.summary.p90)} · mean (average, skewed by outliers){' '}
            {format(histogram.summary.mean)} · over {histogram.summary.contributing} pull requests
          </>
        )
      }
    />
  );
}

/** Work type distribution and the two derived ratios, with segment drill-through. */
export function WorkMixView({
  buckets,
  enabled,
  drillThrough,
  settingsHref,
}: {
  buckets: readonly WorkMixBucket[];
  enabled: boolean;
  drillThrough?: string;
  settingsHref?: string;
}) {
  if (!enabled) {
    return (
      <div className="chart">
        <p className="chart-title">Work mix</p>
        <p className="muted">
          Classification is off for this workspace, so work types and the defect and innovation
          ratios are unavailable. Every other metric on this page is unaffected.{' '}
          {settingsHref ? <a href={settingsHref}>Turn it on in settings</a> : null}
        </p>
      </div>
    );
  }

  const byType = new Map<string, number>();
  let classified = 0;
  let unclassified = 0;
  for (const bucket of buckets) {
    classified += bucket.classified;
    unclassified += bucket.unclassified;
    for (const [type, count] of Object.entries(bucket.byType)) {
      byType.set(type, (byType.get(type) ?? 0) + count);
    }
  }

  const defect = classified === 0 ? null : (byType.get('bug_fix') ?? 0) / classified;
  const innovation = classified === 0 ? null : (byType.get('feature') ?? 0) / classified;

  return (
    <>
      <HistogramChart
        title="Work mix"
        description="Merged pull requests by kind of work."
        bins={[...byType.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([type, count]) => ({
            label: type.replace('_', ' '),
            count,
            href: drillThrough ? `${drillThrough}&workType=${type}` : undefined,
          }))}
        note={
          <>
            Defect ratio {formatShare(defect)} · innovation ratio {formatShare(innovation)} · over{' '}
            {classified} classified pull request(s).{' '}
            {unclassified > 0 ? (
              // Ratios are shown over the classified subset rather than withheld, with the size of
              // the subset stated (spec: "Classification is still running").
              <>
                {unclassified} pull request(s) in this period are not yet classified and are
                excluded from the ratios.
              </>
            ) : null}
          </>
        }
      />
    </>
  );
}
