/**
 * Server-rendered SVG chart primitives (design.md D7, spec: analytics-dashboard).
 *
 * Hand-rolled rather than pulled from a library, for reasons that are requirements rather than
 * taste: values available as text, series distinguishable without colour, absent buckets drawn as
 * gaps rather than zeros, and uncovered buckets marked as uncovered. Every one of those would have
 * to be implemented over a charting library anyway, and the library would be the heaviest
 * dependency in a project that renders on the server and ships no client bundle.
 *
 * Interactivity is what plain links give: a bucket drills through to the pull request list filtered
 * to that bucket. There is no tooltip layer and no hydration.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { UNAVAILABLE } from './format';

/** One bucket's worth of one series. `value: null` is absent — a gap, never a zero. */
export interface ChartPoint {
  label: string;
  value: number | null;
  /** The bucket precedes the relevant coverage start: drawn hatched, and labeled as uncovered. */
  uncovered?: boolean;
  /** Drill-through target for this bucket. */
  href?: string;
}

export interface ChartSeries {
  name: string;
  points: ChartPoint[];
}

/**
 * Four visually distinct patterns. Each series gets a pattern *and* a label, so a viewer who
 * cannot distinguish the colours can still tell the series apart (spec: "Charts are readable
 * without relying on color alone").
 */
export const SERIES_PATTERNS = ['solid', 'dashed', 'dotted', 'dashdot'] as const;

export type SeriesPattern = (typeof SERIES_PATTERNS)[number];

const DASH_ARRAYS: Record<SeriesPattern, string | undefined> = {
  solid: undefined,
  dashed: '6 3',
  dotted: '1 3',
  dashdot: '8 3 2 3',
};

const VIEW_WIDTH = 720;
const VIEW_HEIGHT = 220;
const PADDING = { top: 12, right: 12, bottom: 28, left: 44 };

function niceMax(values: readonly number[]): number {
  const max = Math.max(0, ...values);
  if (max === 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / magnitude) * magnitude;
}

/**
 * The values behind a chart, as text. Visually hidden rather than omitted: it satisfies the
 * "values available as text" requirement and the accessibility one at the same time, and it is
 * what a screen reader reads instead of the SVG.
 */
function ValueTable({
  caption,
  series,
  format,
}: {
  caption: string;
  series: readonly ChartSeries[];
  format: (value: number | null) => string;
}) {
  const labels = series[0]?.points.map((point) => point.label) ?? [];
  return (
    <table className="visually-hidden">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Bucket</th>
          {series.map((entry) => (
            <th key={entry.name} scope="col">
              {entry.name}
            </th>
          ))}
          <th scope="col">Coverage</th>
        </tr>
      </thead>
      <tbody>
        {labels.map((label, index) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            {series.map((entry) => (
              <td key={entry.name}>{format(entry.points[index]?.value ?? null)}</td>
            ))}
            <td>{series[0]?.points[index]?.uncovered ? 'outside coverage' : 'covered'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Legend({ series }: { series: readonly ChartSeries[] }) {
  return (
    <ul className="chart-legend">
      {series.map((entry, index) => (
        <li key={entry.name}>
          <span className={`chart-key chart-key-${SERIES_PATTERNS[index % 4]}`} aria-hidden="true" />
          {entry.name}
        </li>
      ))}
    </ul>
  );
}

/** The hatch uncovered buckets are filled with, defined once per chart. */
function Hatch({ id }: { id: string }) {
  return (
    <defs>
      <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill="var(--bg)" />
        <line x1="0" y1="0" x2="0" y2="6" stroke="var(--border)" strokeWidth="2" />
      </pattern>
    </defs>
  );
}

export interface ChartFrameProps {
  title: string;
  description?: string;
  note?: ReactNode;
  children: ReactNode;
}

export function ChartFrame({ title, description, note, children }: ChartFrameProps) {
  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-title">{title}</span>
        {description ? <span className="muted"> {description}</span> : null}
      </figcaption>
      {children}
      {note ? <p className="chart-note">{note}</p> : null}
    </figure>
  );
}

/**
 * A line chart over buckets. An absent value breaks the path rather than dropping it to zero, so
 * a gap reads as "no value" and not as "nothing happened" (spec: "A bucket has no computable
 * value").
 */
export function LineChart({
  title,
  description,
  series,
  format,
  note,
}: {
  title: string;
  description?: string;
  series: readonly ChartSeries[];
  format: (value: number | null) => string;
  note?: ReactNode;
}) {
  const points = series[0]?.points ?? [];
  if (points.length === 0) {
    return (
      <ChartFrame title={title} description={description} note={note}>
        <p className="muted">No buckets in this period.</p>
      </ChartFrame>
    );
  }

  const values = series.flatMap((entry) =>
    entry.points.map((point) => point.value).filter((value): value is number => value !== null),
  );
  const max = niceMax(values);
  const plotWidth = VIEW_WIDTH - PADDING.left - PADDING.right;
  const plotHeight = VIEW_HEIGHT - PADDING.top - PADDING.bottom;
  const step = points.length === 1 ? plotWidth : plotWidth / (points.length - 1);
  const x = (index: number) => PADDING.left + index * step;
  const y = (value: number) => PADDING.top + plotHeight - (value / max) * plotHeight;
  const hatchId = `hatch-${title.replace(/\W+/g, '-').toLowerCase()}`;
  const uncovered = points.filter((point) => point.uncovered).length;

  return (
    <ChartFrame
      title={title}
      description={description}
      note={
        note ?? (uncovered > 0 ? `${uncovered} bucket(s) fall outside recorded coverage.` : null)
      }
    >
      <svg
        className="chart-svg"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`${title}. The underlying values follow in a table.`}
      >
        <Hatch id={hatchId} />
        {/* Uncovered buckets are shaded before anything is drawn over them. */}
        {points.map((point, index) =>
          point.uncovered ? (
            <rect
              key={`u-${point.label}`}
              x={x(index) - step / 2}
              y={PADDING.top}
              width={step}
              height={plotHeight}
              fill={`url(#${hatchId})`}
            />
          ) : null,
        )}
        <line
          x1={PADDING.left}
          y1={PADDING.top + plotHeight}
          x2={VIEW_WIDTH - PADDING.right}
          y2={PADDING.top + plotHeight}
          stroke="var(--border)"
        />
        <text x="4" y={PADDING.top + 8} className="chart-axis">
          {format(max)}
        </text>
        <text x="4" y={PADDING.top + plotHeight} className="chart-axis">
          0
        </text>

        {series.map((entry, seriesIndex) => {
          // Each run of consecutive present values is its own path: the break between runs is the
          // gap, and it is a gap by construction rather than by styling.
          const runs: string[] = [];
          let current: string[] = [];
          entry.points.forEach((point, index) => {
            if (point.value === null) {
              if (current.length > 0) runs.push(current.join(' '));
              current = [];
              return;
            }
            current.push(`${current.length === 0 ? 'M' : 'L'}${x(index)},${y(point.value)}`);
          });
          if (current.length > 0) runs.push(current.join(' '));

          return runs.map((path, runIndex) => (
            <path
              key={`${entry.name}-${runIndex}`}
              d={path}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={2}
              strokeDasharray={DASH_ARRAYS[SERIES_PATTERNS[seriesIndex % 4]!]}
              opacity={1 - seriesIndex * 0.2}
            />
          ));
        })}

        {points.map((point, index) =>
          point.href ? (
            // Drill-through is a link, not a client-side interaction (design.md D7).
            <Link key={`h-${point.label}`} href={point.href}>
              <rect
                x={x(index) - step / 2}
                y={PADDING.top}
                width={step}
                height={plotHeight}
                fill="transparent"
              >
                <title>{`${point.label}: ${format(point.value)}`}</title>
              </rect>
            </Link>
          ) : null,
        )}

        <text x={PADDING.left} y={VIEW_HEIGHT - 8} className="chart-axis">
          {points[0]!.label}
        </text>
        <text
          x={VIEW_WIDTH - PADDING.right}
          y={VIEW_HEIGHT - 8}
          textAnchor="end"
          className="chart-axis"
        >
          {points.at(-1)!.label}
        </text>
      </svg>
      <Legend series={series} />
      <ValueTable caption={`${title} by bucket`} series={series} format={format} />
    </ChartFrame>
  );
}

/**
 * A stacked bar chart — the cycle-time phase decomposition and the churn composition.
 *
 * A bucket where every segment is absent is left empty rather than drawn as a zero-height bar, so
 * "we could not compute this" and "this was zero" stay different pictures.
 */
export function StackedBarChart({
  title,
  description,
  series,
  format,
  note,
}: {
  title: string;
  description?: string;
  series: readonly ChartSeries[];
  format: (value: number | null) => string;
  note?: ReactNode;
}) {
  const points = series[0]?.points ?? [];
  if (points.length === 0) {
    return (
      <ChartFrame title={title} description={description} note={note}>
        <p className="muted">No buckets in this period.</p>
      </ChartFrame>
    );
  }

  const totals = points.map((_, index) =>
    series.reduce((sum, entry) => sum + (entry.points[index]?.value ?? 0), 0),
  );
  const max = niceMax(totals);
  const plotWidth = VIEW_WIDTH - PADDING.left - PADDING.right;
  const plotHeight = VIEW_HEIGHT - PADDING.top - PADDING.bottom;
  const slot = plotWidth / points.length;
  const barWidth = Math.max(2, slot * 0.7);
  const hatchId = `hatch-${title.replace(/\W+/g, '-').toLowerCase()}`;
  const uncovered = points.filter((point) => point.uncovered).length;

  return (
    <ChartFrame
      title={title}
      description={description}
      note={
        note ?? (uncovered > 0 ? `${uncovered} bucket(s) fall outside recorded coverage.` : null)
      }
    >
      <svg
        className="chart-svg"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`${title}. The underlying values follow in a table.`}
      >
        <Hatch id={hatchId} />
        {points.map((point, index) => {
          const left = PADDING.left + index * slot + (slot - barWidth) / 2;
          if (point.uncovered) {
            return (
              <rect
                key={`u-${point.label}`}
                x={left}
                y={PADDING.top}
                width={barWidth}
                height={plotHeight}
                fill={`url(#${hatchId})`}
              />
            );
          }

          let offset = 0;
          const segments = series.map((entry, seriesIndex) => {
            const value = entry.points[index]?.value;
            if (value === null || value === undefined) return null;
            const height = (value / max) * plotHeight;
            const rect = (
              <rect
                key={`${entry.name}-${point.label}`}
                x={left}
                y={PADDING.top + plotHeight - offset - height}
                width={barWidth}
                height={Math.max(0, height)}
                fill="var(--accent)"
                opacity={1 - seriesIndex * 0.25}
                stroke="var(--surface)"
                strokeWidth={0.5}
                strokeDasharray={DASH_ARRAYS[SERIES_PATTERNS[seriesIndex % 4]!]}
              >
                <title>{`${entry.name} · ${point.label}: ${format(value)}`}</title>
              </rect>
            );
            offset += height;
            return rect;
          });

          const body = <g key={point.label}>{segments}</g>;
          return point.href ? (
            <Link key={`l-${point.label}`} href={point.href}>
              {body}
            </Link>
          ) : (
            body
          );
        })}
        <line
          x1={PADDING.left}
          y1={PADDING.top + plotHeight}
          x2={VIEW_WIDTH - PADDING.right}
          y2={PADDING.top + plotHeight}
          stroke="var(--border)"
        />
        <text x="4" y={PADDING.top + 8} className="chart-axis">
          {format(max)}
        </text>
        <text x={PADDING.left} y={VIEW_HEIGHT - 8} className="chart-axis">
          {points[0]!.label}
        </text>
        <text
          x={VIEW_WIDTH - PADDING.right}
          y={VIEW_HEIGHT - 8}
          textAnchor="end"
          className="chart-axis"
        >
          {points.at(-1)!.label}
        </text>
      </svg>
      <Legend series={series} />
      <ValueTable caption={`${title} by bucket`} series={series} format={format} />
    </ChartFrame>
  );
}

export interface HistogramDatum {
  label: string;
  count: number;
  href?: string;
}

/**
 * A histogram over bands. Used where a single number would hide the shape of a skewed
 * distribution (spec: "Skewed metrics are presented as distributions").
 */
export function HistogramChart({
  title,
  description,
  bins,
  note,
  tooSmall,
}: {
  title: string;
  description?: string;
  bins: readonly HistogramDatum[];
  note?: ReactNode;
  /** Below the workspace's minimum sample size: say so rather than drawing a shape. */
  tooSmall?: boolean;
}) {
  const total = bins.reduce((sum, bin) => sum + bin.count, 0);

  if (tooSmall || total === 0) {
    return (
      <ChartFrame title={title} description={description} note={note}>
        <p className="muted">
          {total === 0
            ? 'No pull requests in this period.'
            : 'Too few pull requests in this period to describe a distribution.'}
        </p>
      </ChartFrame>
    );
  }

  return (
    <ChartFrame title={title} description={description} note={note}>
      <ul className="distribution">
        {bins.map((bin) => (
          <li key={bin.label}>
            <span className="distribution-label">
              {bin.href ? <Link href={bin.href}>{bin.label}</Link> : bin.label}
            </span>
            <span className="distribution-bar">
              <span style={{ width: `${(bin.count / total) * 100}%` }} />
            </span>
            <span className="distribution-count">{bin.count}</span>
          </li>
        ))}
      </ul>
    </ChartFrame>
  );
}

/**
 * A benchmark tier and the band that produced it. Named as published industry data, never as a
 * target the workspace set (spec: "Benchmarked metrics show their tier and thresholds").
 */
export function BenchmarkTier({
  tier,
  lowerBound,
  upperBound,
  source,
  format,
}: {
  tier: string | null;
  lowerBound: number | null;
  upperBound: number | null;
  source: string;
  format: (value: number | null) => string;
}) {
  if (tier === null) {
    return <span className="muted">No published benchmark for this metric.</span>;
  }
  const band =
    lowerBound === null
      ? `under ${format(upperBound)}`
      : upperBound === null
        ? `${format(lowerBound)} and above`
        : `${format(lowerBound)} – ${format(upperBound)}`;
  return (
    <span className="benchmark">
      <span className={`benchmark-tier benchmark-${tier}`}>{tier.replace('_', ' ')}</span>
      <span className="muted">
        {' '}
        ({band}, p75) · {source}. Published industry data, not a target this workspace set.
      </span>
    </span>
  );
}

/** Day / week / month, re-bucketing the same period rather than changing it. */
export function GranularitySelector({
  granularity,
  basePath,
  query,
}: {
  granularity: string;
  basePath: string;
  query: string;
}) {
  return (
    <div className="period">
      <span className="muted">Granularity:</span>
      {['day', 'week', 'month'].map((option) => (
        <Link
          key={option}
          className={option === granularity ? 'chip chip-active' : 'chip'}
          href={`${basePath}?${query}&granularity=${option}`}
        >
          {option}
        </Link>
      ))}
    </div>
  );
}

export const CHART_UNAVAILABLE = UNAVAILABLE;
