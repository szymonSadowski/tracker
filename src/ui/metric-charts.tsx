/**
 * The chart suite the team and personal views share (spec: analytics-dashboard).
 *
 * Every chart here reads the same rollup layer the headline tiles read, so a tile and the chart
 * beside it cannot disagree. Each one carries its own honesty: buckets outside coverage are
 * hatched and named, absent values are gaps, and a decomposition says how much of the bucket it
 * actually accounts for.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  BenchmarkTier,
  HistogramChart,
  LineChart,
  StackedBarChart,
  StepChart,
  type ChartEventSeries,
  type ChartPoint,
  type ChartSeries,
} from './charts';
import { formatCount, formatDuration, formatNumber, UNAVAILABLE } from './format';
import type { BenchmarkAssignment } from '../analysis/benchmarks';
import type {
  ContributorThroughput,
  Histogram,
  MergeEventSeries,
  MetricBucket,
  WorkMixBucket,
} from '../analysis/series';

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

/**
 * Throughput, with its benchmark tier stated in the unit the study publishes.
 *
 * Two variants, because the same normalization does not mean the same thing at both scopes
 * (design.md D8). On a team the denominator is the people in it, and a rate per contributor is the
 * comparable figure. On one person the denominator is that person's own tenure fraction, so the
 * rate describes how long they have been a member rather than what they merged — the count is the
 * honest quantity there, and it is the one the view's own headline tile states.
 */
export function ThroughputChart({
  buckets,
  drillThrough,
  benchmark,
  variant = 'per-contributor',
}: {
  buckets: readonly MetricBucket[];
  drillThrough?: string;
  benchmark?: BenchmarkAssignment;
  variant?: 'per-contributor' | 'count';
}) {
  const perContributor = variant === 'per-contributor';
  // A count carries no benchmark: the published band is stated per contributor per day, and has
  // nothing to say about a raw count (spec: benchmarks are stated in their own unit).
  const tier = perContributor ? benchmark : undefined;
  // Only meaningful against a rate. A count variant is already a count, so there is no stand-in to
  // declare (design.md D9).
  const standingIn = perContributor
    ? buckets.filter((bucket) => bucket.denominatorMissing && !bucket.outsideCoverage).length
    : 0;

  return (
    <LineChart
      title={perContributor ? 'PR throughput per contributor' : 'Merged pull requests'}
      description={
        perContributor
          ? 'Merged pull requests divided by the prorated contributors in scope.'
          : 'Pull requests merged in each bucket. Summed over the period, this is the merged count stated above.'
      }
      series={[
        {
          name: perContributor ? 'Per contributor' : 'Merged',
          points: toPoints(
            buckets,
            (bucket) => (perContributor ? bucket.throughputPerContributor : bucket.mergedCount),
            drillThrough,
          ),
        },
      ]}
      format={(value) =>
        value === null ? UNAVAILABLE : perContributor ? formatNumber(value, 2) : formatCount(value)
      }
      note={
        tier || standingIn > 0 ? (
          <>
            {standingIn > 0 ? (
              // Said rather than silently drawn: the alternative is a number under a "per
              // contributor" label that is not one (design.md D9).
              <>
                {standingIn} bucket(s) have merged pull requests but no contributor on record for
                the period, so their figure is the merged count standing in for a rate.{' '}
              </>
            ) : null}
            {tier ? (
              <BenchmarkTier
                tier={tier.tier}
                lowerBound={tier.lowerBound}
                upperBound={tier.upperBound}
                source={tier.source}
                format={(value) => (value === null ? '—' : `${formatNumber(value, 2)}/day`)}
              />
            ) : null}
          </>
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
 * The composition of changed lines. Shares by default because the question is usually "what kind
 * of work is this", with absolute line counts a toggle away for when the question is "how much".
 *
 * The chart is titled for what it draws rather than for the metric family it belongs to
 * (design.md D6). "Code churn" outside this codebase means recently-written code rewritten again,
 * which is the rework band alone — a viewer who knows the term reads "Code churn 95%" off a
 * three-way composition as a catastrophe when 95% is the new-code band.
 */
export function ChurnChart({
  buckets,
  drillThrough,
  absolute = false,
  toggleHref,
  coveredFrom,
  reworkThreshold,
  refactorThreshold,
  refactorBenchmark,
  reworkRecencyDays = 21,
}: {
  buckets: readonly MetricBucket[];
  drillThrough?: string;
  absolute?: boolean;
  toggleHref?: string;
  coveredFrom?: Date | null;
  /** The needs-focus rework threshold, so a bucket above it can be marked against it. */
  reworkThreshold?: number | null;
  /** The needs-focus refactor threshold, stated in the note rather than drawn (design.md D5). */
  refactorThreshold?: number | null;
  refactorBenchmark?: BenchmarkAssignment;
  /** The workspace's rework recency window, so "recently written" carries a number. */
  reworkRecencyDays?: number;
}) {
  const pick = (
    lines: (bucket: MetricBucket) => number | null,
    share: (bucket: MetricBucket) => number | null,
  ) => (absolute ? lines : share);

  // Stacked from the axis upwards, so the benchmarked bands sit against the axis the threshold
  // rule is measured from. With rework on top of the stack its band would start at 70-odd percent
  // and a rule at 9% would be a line the band's height could not be read against — which is the
  // one thing the rule exists to allow (design.md D5).
  const series: ChartSeries[] = [
    {
      // The band the published benchmarks actually score, named with the term they use for it.
      name: 'Rework (code churn)',
      points: toPoints(
        buckets,
        pick(
          (bucket) => bucket.churn?.reworkLines ?? null,
          (bucket) => bucket.churn?.reworkShare ?? null,
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
  ];

  const overThreshold =
    reworkThreshold === null || reworkThreshold === undefined
      ? []
      : buckets.filter((bucket) => (bucket.churn?.reworkShare ?? 0) >= reworkThreshold);
  const estimated = buckets.some((bucket) => bucket.churn?.usedRecencyEstimate);
  // A share threshold has nothing to compare itself to on a line-count plot, so it is withheld
  // there and said to be withheld rather than silently dropped (design.md D5).
  const showThreshold = !absolute && reworkThreshold !== null && reworkThreshold !== undefined;

  return (
    <StackedBarChart
      title={absolute ? 'Change composition (lines)' : 'Change composition (share)'}
      description={`New code, refactor, and rework per bucket. Rework counts lines rewritten within ${reworkRecencyDays} days of being written, or after the pull request's first review.`}
      series={series}
      format={absolute ? formatLines : formatShare}
      // Shares are scaled to the whole they are shares of, never to what the data rounded to.
      max={absolute ? undefined : 1}
      threshold={
        showThreshold
          ? {
              value: reworkThreshold,
              label: 'needs-focus rework threshold',
              marked: overThreshold.map((bucket) => bucket.label),
            }
          : null
      }
      note={
        <>
          {coveredFrom ? (
            <>Per-file diff data exists from {coveredFrom.toISOString().slice(0, 10)} onwards. </>
          ) : null}
          {overThreshold.length > 0 ? (
            // The prose is the accessible channel for the rule and the bucket markers, not a
            // duplicate of them.
            <>
              {overThreshold.length} bucket(s) at or above the needs-focus rework threshold of{' '}
              {formatShare(reworkThreshold ?? null)}:{' '}
              {overThreshold.map((bucket) => bucket.label).join(', ')}.{' '}
            </>
          ) : null}
          {absolute && reworkThreshold !== null && reworkThreshold !== undefined ? (
            <>
              The needs-focus rework threshold is a share, so it is not drawn on the line-count
              view; switch to shares to see it.{' '}
            </>
          ) : null}
          {refactorThreshold !== null && refactorThreshold !== undefined ? (
            <>
              The published study puts the needs-focus refactor band at{' '}
              {formatShare(refactorThreshold)} and above.{' '}
            </>
          ) : null}
          {/*
           * Which end is better, attributed to the study rather than presented as a target this
           * workspace set (spec: "A viewer asks what a high rework share means").
           */}
          <>
            The published benchmark treats a lower rework share and a lower refactor share as
            better; new code carries no benchmark.{' '}
          </>
          {refactorBenchmark ? (
            <>
              Refactor over this period:{' '}
              <BenchmarkTier
                tier={refactorBenchmark.tier}
                lowerBound={refactorBenchmark.lowerBound}
                upperBound={refactorBenchmark.upperBound}
                source={refactorBenchmark.source}
                format={formatShare}
              />{' '}
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

/** How many lines can be drawn at once and still be told apart without colour. */
export const MAX_SELECTED_AUTHORS = 4;

/**
 * Merged pull requests per bucket, one line per author (spec: analytics-dashboard "Throughput is
 * available as a series per team member").
 *
 * The selector is not a convenience. There are four series encodings, so a fifth line would repeat
 * a dash pattern already in use and the chart would stop satisfying "readable without relying on
 * colour alone" — the cap is what keeps the guarantee true rather than nominally declared. Which
 * lines are shown lives in the URL like every other control on these surfaces, so the chart stays
 * server-rendered and the view stays linkable.
 */
export function ContributorThroughputChart({
  data,
  selected,
  hrefFor,
  drillThrough,
}: {
  data: ContributorThroughput;
  /** Contributor ids currently drawn, already capped by the caller. */
  selected: readonly string[];
  /** The href that toggles one contributor in or out of the selection. */
  hrefFor: (contributorId: string) => string;
  drillThrough?: string;
}) {
  if (data.contributors.length === 0) {
    return (
      <LineChart
        title="Merged pull requests by author"
        description="One line per author, counted in the bucket their pull request merged in."
        series={[]}
        format={(value) => (value === null ? UNAVAILABLE : formatCount(value))}
        note="No merged pull requests from a named author in this period."
      />
    );
  }

  const chosen = new Set(selected);
  const series: ChartSeries[] = data.contributors
    .filter((contributor) => chosen.has(contributor.contributorId))
    .map((contributor) => ({
      name: contributor.name,
      points: data.buckets.map((bucket, index) => ({
        label: bucket.label,
        value: bucket.outsideCoverage ? null : (contributor.points[index] ?? null),
        uncovered: bucket.outsideCoverage,
        href: drillThrough
          ? `${drillThrough}${drillThrough.includes('?') ? '&' : '?'}from=${bucket.start.toISOString()}&to=${bucket.end.toISOString()}&author=${contributor.contributorId}`
          : undefined,
      })),
    }));

  const atCap = chosen.size >= MAX_SELECTED_AUTHORS;

  return (
    <LineChart
      title="Merged pull requests by author"
      // With nothing selected LineChart would report "No buckets in this period", which blames the
      // period for a choice the viewer just made. An empty selection is a state, not an absence.
      emptyMessage={chosen.size === 0 ? 'No authors selected.' : undefined}
      description="One line per author, counted in the bucket their pull request merged in. A gap is a bucket before that person joined the workspace, not a bucket where they merged nothing."
      series={series}
      format={(value) => (value === null ? UNAVAILABLE : formatCount(value))}
      note={
        <div className="series-picker">
          <span className="muted">Authors:</span>
          {data.contributors.map((contributor) => {
            const on = chosen.has(contributor.contributorId);
            // A chip that would exceed the cap is rendered as text rather than a link, so the
            // limit is visible before it is hit instead of a click that silently does nothing.
            const disabled = !on && atCap;
            return disabled ? (
              <span
                key={contributor.contributorId}
                className="chip chip-disabled"
                title={`Deselect an author to add another (limit ${MAX_SELECTED_AUTHORS}).`}
              >
                {contributor.name}
              </span>
            ) : (
              <Link
                key={contributor.contributorId}
                className={on ? 'chip chip-active' : 'chip'}
                href={hrefFor(contributor.contributorId)}
              >
                {contributor.name}
              </Link>
            );
          })}
          <span className="muted">
            {chosen.size} of {data.contributors.length} shown
            {atCap
              ? `; ${MAX_SELECTED_AUTHORS} is the limit that keeps the lines distinguishable`
              : ''}
          </span>
        </div>
      }
    />
  );
}

/**
 * Merged pull requests as a cumulative line, one step per pull request (spec: analytics-dashboard
 * "Merged throughput is presentable per pull request").
 *
 * Not a second metric. It is the merged count the headline tile states, at the resolution of the
 * pull request rather than the bucket: the line's final value is that count, by construction
 * rather than by two code paths happening to agree (design.md D3). The running total is the
 * event's position in its own group, so there is nowhere for a second definition of "the total" to
 * live.
 *
 * Series stay in the name order `mergeEventSeries` returns them in. A cumulative line does end at
 * a person's total, which makes totals comparable — but it is the comparability four bars already
 * have, and nothing upstream returns people ordered by it (design.md D10).
 */
export function CumulativeThroughputChart({
  data,
  periodStart,
  periodEnd,
  selected,
  timeZone,
  emptyMessage,
}: {
  data: MergeEventSeries;
  periodStart: Date;
  periodEnd: Date;
  /** Contributor ids to draw, already capped by the caller. Undefined draws every group. */
  selected?: readonly string[];
  timeZone?: string;
  /** What a period with no merges says, where the surface has its own framing for that. */
  emptyMessage?: string;
}) {
  const chosen = selected === undefined ? null : new Set(selected);
  const groups =
    chosen === null
      ? data.contributors
      : data.contributors.filter((group) => chosen.has(group.contributorId));

  const series: ChartEventSeries[] = groups.map((group) => ({
    name: group.name,
    events: group.events.map((event, index) => ({
      at: event.mergedAt,
      // The running total is the event's own position in the group: one merge raises the line by
      // exactly one, whatever that merge contained.
      value: index + 1,
      label: `#${event.number} ${event.title}`,
      href: event.url ?? undefined,
    })),
  }));

  return (
    <StepChart
      title="Cumulative merged pull requests"
      description="One step per merged pull request, placed when it merged. The line ends at the same merged count stated above; only its resolution is finer."
      series={series}
      periodStart={periodStart}
      periodEnd={periodEnd}
      coverageStart={data.coverageStart}
      timeZone={timeZone}
      format={(value) => (value === null ? UNAVAILABLE : formatCount(value))}
      // An empty selection is a choice the viewer just made, not a period without merges.
      emptyMessage={chosen !== null && chosen.size === 0 ? 'No authors selected.' : emptyMessage}
      note={
        data.truncated ? (
          // Said rather than drawn short: a line quietly ending below the headline count is the
          // worst failure available to a chart whose whole claim is that the two agree (D6).
          <>
            More merged pull requests fall in this period than the chart reads, so the line stops
            short of the count stated above. Narrow the period to see them all.
          </>
        ) : null
      }
    />
  );
}
