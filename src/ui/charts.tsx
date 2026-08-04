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
 * One encoding per series, consumed by the marks *and* by the legend (design.md D2).
 *
 * The legend used to describe series by border-style while the bars distinguished them by fill
 * opacity, so nothing connected a legend entry to a segment. One descriptor is what keeps them
 * from drifting apart again: `key` names the encoding in both the mark's class and the swatch's,
 * so the correspondence is assertable rather than a matter of two files agreeing by habit.
 *
 * Opacity is kept *underneath* the texture rather than replaced by it: a sliver too small to show
 * a texture still differs in lightness. Lightness alone was the bug; lightness as a fallback is
 * not (spec: "Charts are readable without relying on color alone").
 */
export interface SeriesEncoding {
  /** Names the encoding in `chart-mark-<key>` and `chart-key-<key>`. */
  key: string;
  /** Stroke dash for line marks and for the legend's line swatch. */
  dash?: string;
  /** Suffix of the per-chart `<pattern>` id that fills area marks. */
  texture: 'plain' | 'diagonal' | 'cross' | 'dots';
  opacity: number;
}

export const SERIES_ENCODINGS: readonly SeriesEncoding[] = [
  { key: 'primary', texture: 'plain', opacity: 1 },
  { key: 'secondary', dash: '6 3', texture: 'diagonal', opacity: 0.85 },
  { key: 'tertiary', dash: '1 3', texture: 'cross', opacity: 0.7 },
  { key: 'quaternary', dash: '8 3 2 3', texture: 'dots', opacity: 0.55 },
];

/** The encoding for the nth series, wrapping so a chart with more series still draws. */
export function seriesEncoding(index: number): SeriesEncoding {
  return SERIES_ENCODINGS[index % SERIES_ENCODINGS.length]!;
}

/** Whether a chart's marks are strokes or fills, so its legend can show the same thing. */
export type LegendKind = 'line' | 'fill';

const VIEW_WIDTH = 720;
const VIEW_HEIGHT = 220;
const PADDING = { top: 12, right: 12, bottom: 28, left: 44 };

/** Horizontal gridlines above the baseline, each carrying its value in the axis gutter. */
const GRID_DIVISIONS = 4;

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

/**
 * The legend, in the encoding the chart's marks actually carry: a line swatch for a chart drawn
 * with strokes, a filled and textured swatch for one drawn with areas (spec: "A viewer matches a
 * legend entry to a mark").
 */
function Legend({
  series,
  kind,
}: {
  // Only the name is read, so bucketed and event series share one legend rather than two that
  // could drift about what a swatch means.
  series: readonly { name: string }[];
  kind: LegendKind;
}) {
  return (
    <ul className="chart-legend">
      {series.map((entry, index) => (
        <li key={entry.name}>
          <span
            className={`chart-key chart-key-${kind} chart-key-${seriesEncoding(index).key}`}
            aria-hidden="true"
          />
          {entry.name}
        </li>
      ))}
    </ul>
  );
}

/** SVG ids have to be unique within the document, so every chart namespaces its own. */
function chartId(title: string): string {
  return title.replace(/\W+/g, '-').toLowerCase();
}

/** The hatch uncovered buckets are filled with, defined once per chart. */
function Hatch({ id }: { id: string }) {
  return (
    <defs>
      <pattern
        id={id}
        width="6"
        height="6"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(45)"
      >
        <rect width="6" height="6" fill="var(--bg)" />
        <line x1="0" y1="0" x2="0" y2="6" stroke="var(--border)" strokeWidth="2" />
      </pattern>
    </defs>
  );
}

/**
 * The series textures area marks are filled with, namespaced per chart as the hatch is. A genuine
 * texture survives greyscale and low-vision viewing in a way three steps of one accent's lightness
 * does not.
 */
function SeriesTextures({ prefix }: { prefix: string }) {
  return (
    <defs>
      {SERIES_ENCODINGS.map((encoding) => (
        <pattern
          key={encoding.key}
          id={`${prefix}-${encoding.texture}`}
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
        >
          <rect width="6" height="6" fill="var(--accent)" />
          {encoding.texture === 'diagonal' ? (
            <path d="M0,6 L6,0" stroke="var(--surface)" strokeWidth="1.5" />
          ) : null}
          {encoding.texture === 'cross' ? (
            <path d="M0,6 L6,0 M0,0 L6,6" stroke="var(--surface)" strokeWidth="1.2" />
          ) : null}
          {encoding.texture === 'dots' ? (
            <circle cx="3" cy="3" r="1.6" fill="var(--surface)" />
          ) : null}
        </pattern>
      ))}
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
  emptyMessage,
}: {
  title: string;
  description?: string;
  series: readonly ChartSeries[];
  format: (value: number | null) => string;
  note?: ReactNode;
  /** Replaces the default when the chart has nothing to draw for a reason other than an empty period. */
  emptyMessage?: string;
}) {
  const points = series[0]?.points ?? [];
  if (points.length === 0) {
    return (
      <ChartFrame title={title} description={description} note={note}>
        <p className="muted">{emptyMessage ?? 'No buckets in this period.'}</p>
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
  const hatchId = `hatch-${chartId(title)}`;
  const uncovered = points.filter((point) => point.uncovered).length;
  // Gridlines give the plot a scale to read a point against. Two labels — the maximum and zero —
  // leave everything between them to be estimated against nothing.
  const gridValues = Array.from(
    { length: GRID_DIVISIONS },
    (_, i) => (max * (i + 1)) / GRID_DIVISIONS,
  );
  // Enough bucket labels to locate a point along the axis, thinned so they cannot collide. The
  // last bucket is always labelled, and a label that would crowd it is dropped rather than drawn.
  const labelStep = Math.max(1, Math.ceil(points.length / 6));
  const labelled = points
    .map((_, index) => index)
    .filter(
      (index) =>
        index === points.length - 1 ||
        (index % labelStep === 0 && points.length - 1 - index > labelStep / 2),
    );

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
        {gridValues.map((value) => (
          <g key={`g-${value}`}>
            <line
              className="chart-grid"
              x1={PADDING.left}
              y1={y(value)}
              x2={VIEW_WIDTH - PADDING.right}
              y2={y(value)}
            />
            <text x="4" y={y(value) + 4} className="chart-axis">
              {format(value)}
            </text>
          </g>
        ))}
        <line
          x1={PADDING.left}
          y1={PADDING.top + plotHeight}
          x2={VIEW_WIDTH - PADDING.right}
          y2={PADDING.top + plotHeight}
          stroke="var(--border)"
        />
        <text x="4" y={PADDING.top + plotHeight + 4} className="chart-axis">
          0
        </text>

        {series.map((entry, seriesIndex) => {
          const encoding = seriesEncoding(seriesIndex);
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

          return (
            <g key={entry.name}>
              {runs.map((path, runIndex) => (
                <path
                  key={`${entry.name}-${runIndex}`}
                  className={`chart-mark chart-mark-${encoding.key}`}
                  d={path}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={2}
                  strokeDasharray={encoding.dash}
                  opacity={encoding.opacity}
                />
              ))}
              {/*
               * A run of one point strokes a bare moveto, which draws nothing at all: the value
               * disappears because its neighbours are absent, which is the misreading the
               * gaps-are-not-zeros rule exists to prevent. A marker gives every run a form
               * independent of its length (design.md D1).
               */}
              {entry.points.map((point, index) =>
                point.value === null ? null : (
                  <circle
                    key={`${entry.name}-p-${point.label}`}
                    className={`chart-mark chart-mark-${encoding.key}`}
                    cx={x(index)}
                    cy={y(point.value)}
                    r={3}
                    fill="var(--accent)"
                    opacity={encoding.opacity}
                  />
                ),
              )}
            </g>
          );
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

        {labelled.map((index) => (
          <text
            key={`x-${points[index]!.label}`}
            x={x(index)}
            y={VIEW_HEIGHT - 8}
            textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
            className="chart-axis"
          >
            {points[index]!.label}
          </text>
        ))}
      </svg>
      <Legend series={series} kind="line" />
      <ValueTable caption={`${title} by bucket`} series={series} format={format} />
    </ChartFrame>
  );
}

/** One event on a time-positioned chart: an instant, the running value at it, and its identity. */
export interface ChartEvent {
  at: Date;
  /** The series' value once this event has happened — for a cumulative line, its running total. */
  value: number;
  /** Names the event itself, e.g. `#412 Fix the retry loop`. */
  label: string;
  /** Where the event itself lives, so a mark leads to the thing it stands for. */
  href?: string;
}

export interface ChartEventSeries {
  name: string;
  events: ChartEvent[];
}

/**
 * How many events one series draws as separate marks.
 *
 * Above roughly this many the circles collide and the plot becomes a smear, so the marks thin
 * while the path passes through every event and the table lists every event (design.md D5). The
 * guarantee is on the line and the text, never on the circle count.
 */
export const MAX_EVENT_MARKS = 40;

/** Evenly spaced indices, always including the first and the last. */
function thinIndices(count: number, limit: number): number[] {
  if (count <= limit) return Array.from({ length: count }, (_, index) => index);
  const stride = (count - 1) / (limit - 1);
  return [...new Set(Array.from({ length: limit }, (_, i) => Math.round(i * stride)))];
}

/** Positions along the period the axis labels, formatted in the workspace's zone. */
const AXIS_TICKS = 5;

/**
 * A step chart over individual events, positioned by when they happened (design.md D1, D2).
 *
 * Separate from `LineChart` rather than a mode on it: `LineChart` derives its x positions, its
 * axis, and its value table's label column from one shared bucket list, and events have none —
 * two people's merges land at different instants, and there is a row per event rather than per
 * bucket.
 *
 * The line steps rather than slopes. Between two events the running total is genuinely constant,
 * and a diagonal would draw a value the series never held at a time it did not hold it — mid-slope
 * a cumulative merge count would be a fraction of a pull request. The vertical is the event; the
 * horizontal is the wait.
 *
 * It is anchored at both ends of the period: at zero where the period starts, and carried flat to
 * where it ends. The trailing anchor is what makes the final value the period's total by
 * construction rather than by two code paths agreeing (design.md D3).
 */
export function StepChart({
  title,
  description,
  series,
  periodStart,
  periodEnd,
  format,
  note,
  emptyMessage,
  coverageStart,
  timeZone = 'UTC',
}: {
  title: string;
  description?: string;
  series: readonly ChartEventSeries[];
  periodStart: Date;
  periodEnd: Date;
  format: (value: number | null) => string;
  note?: ReactNode;
  /** Replaces the default when the chart has nothing to draw for a reason other than no merges. */
  emptyMessage?: string;
  /** Events are complete only from here: the span before it is hatched and named. */
  coverageStart?: Date | null;
  timeZone?: string;
}) {
  const total = series.reduce((sum, entry) => sum + entry.events.length, 0);
  if (total === 0) {
    return (
      <ChartFrame title={title} description={description} note={note}>
        {/*
         * "No merges in this period", never "no buckets": the period is not empty, the record of
         * merges within it is. A line drawn flat at zero would assert a measured nothing across a
         * span that may not even be covered.
         */}
        <p className="muted">{emptyMessage ?? 'No pull requests merged in this period.'}</p>
      </ChartFrame>
    );
  }

  const span = Math.max(1, periodEnd.getTime() - periodStart.getTime());
  const plotWidth = VIEW_WIDTH - PADDING.left - PADDING.right;
  const plotHeight = VIEW_HEIGHT - PADDING.top - PADDING.bottom;
  const max = niceMax(series.flatMap((entry) => entry.events.map((event) => event.value)));
  // A fraction of the period computed from two instants, so no calendar arithmetic happens here
  // and a daylight-saving boundary inside the period cannot shift a position.
  const x = (at: Date): number => {
    const fraction = (at.getTime() - periodStart.getTime()) / span;
    return PADDING.left + Math.min(1, Math.max(0, fraction)) * plotWidth;
  };
  const y = (value: number): number => PADDING.top + plotHeight - (value / max) * plotHeight;
  const round = (value: number): number => Math.round(value * 100) / 100;
  const hatchId = `hatch-${chartId(title)}`;

  const formatInstant = (at: Date): string =>
    new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    }).format(at);
  const formatTick = (at: Date): string =>
    new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone }).format(at);

  const gridValues = Array.from(
    { length: GRID_DIVISIONS },
    (_, i) => (max * (i + 1)) / GRID_DIVISIONS,
  );
  const ticks = Array.from(
    { length: AXIS_TICKS },
    (_, i) => new Date(periodStart.getTime() + (span * i) / (AXIS_TICKS - 1)),
  );
  const uncoveredUntil =
    coverageStart && coverageStart > periodStart
      ? new Date(Math.min(coverageStart.getTime(), periodEnd.getTime()))
      : null;

  return (
    <ChartFrame
      title={title}
      description={description}
      note={
        uncoveredUntil ? (
          <>
            Merges before {formatTick(uncoveredUntil)} fall outside recorded coverage, so the flat
            run there is missing data rather than a quiet stretch. {note}
          </>
        ) : (
          note
        )
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
        {uncoveredUntil ? (
          <rect
            x={PADDING.left}
            y={PADDING.top}
            width={Math.max(0, round(x(uncoveredUntil) - PADDING.left))}
            height={plotHeight}
            fill={`url(#${hatchId})`}
          >
            <title>Outside recorded coverage.</title>
          </rect>
        ) : null}
        {gridValues.map((value) => (
          <g key={`g-${value}`}>
            <line
              className="chart-grid"
              x1={PADDING.left}
              y1={y(value)}
              x2={VIEW_WIDTH - PADDING.right}
              y2={y(value)}
            />
            <text x="4" y={y(value) + 4} className="chart-axis">
              {format(value)}
            </text>
          </g>
        ))}
        <line
          x1={PADDING.left}
          y1={PADDING.top + plotHeight}
          x2={VIEW_WIDTH - PADDING.right}
          y2={PADDING.top + plotHeight}
          stroke="var(--border)"
        />
        <text x="4" y={PADDING.top + plotHeight + 4} className="chart-axis">
          0
        </text>

        {series.map((entry, seriesIndex) => {
          const encoding = seriesEncoding(seriesIndex);
          // Horizontal to the event, then vertical to its new value. Written as H and V rather
          // than L so a diagonal is not merely avoided but unexpressible here.
          const path = [
            `M${round(x(periodStart))},${round(y(0))}`,
            ...entry.events.map((event) => `H${round(x(event.at))} V${round(y(event.value))}`),
            `H${round(x(periodEnd))}`,
          ].join(' ');
          const drawn = thinIndices(entry.events.length, MAX_EVENT_MARKS);

          return (
            <g key={entry.name}>
              <path
                className={`chart-mark chart-step chart-mark-${encoding.key}`}
                d={path}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={2}
                strokeDasharray={encoding.dash}
                opacity={encoding.opacity}
              />
              {drawn.map((index) => {
                const event = entry.events[index]!;
                const mark = (
                  <circle
                    className={`chart-mark chart-event chart-mark-${encoding.key}`}
                    cx={round(x(event.at))}
                    cy={round(y(event.value))}
                    r={3}
                    fill="var(--accent)"
                    opacity={encoding.opacity}
                  >
                    {/*
                     * A native title is the whole hover affordance: there is no tooltip layer and
                     * no hydration, and the table below carries the same facts as text (D4).
                     */}
                    <title>{`${entry.name} · ${event.label} · ${formatInstant(event.at)} · ${format(event.value)}`}</title>
                  </circle>
                );
                return event.href ? (
                  <a
                    key={`${entry.name}-${event.label}-${index}`}
                    href={event.href}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {mark}
                  </a>
                ) : (
                  <g key={`${entry.name}-${event.label}-${index}`}>{mark}</g>
                );
              })}
            </g>
          );
        })}

        {ticks.map((tick, index) => (
          <text
            key={`x-${tick.getTime()}`}
            x={round(x(tick))}
            y={VIEW_HEIGHT - 8}
            textAnchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'}
            className="chart-axis"
          >
            {formatTick(tick)}
          </text>
        ))}
      </svg>
      <Legend series={series} kind="line" />
      {/*
       * One row per event, not per bucket: this is what a screen reader reads instead of the SVG,
       * and it is where the completeness guarantee lives when the marks have thinned.
       */}
      <table className="visually-hidden">
        <caption>{`${title} by pull request`}</caption>
        <thead>
          <tr>
            <th scope="col">Series</th>
            <th scope="col">Pull request</th>
            <th scope="col">Merged</th>
            <th scope="col">Running total</th>
          </tr>
        </thead>
        <tbody>
          {series.flatMap((entry) =>
            entry.events.map((event, index) => (
              <tr key={`${entry.name}-${event.label}-${index}`}>
                <td>{entry.name}</td>
                <th scope="row">{event.label}</th>
                <td>{formatInstant(event.at)}</td>
                <td>{format(event.value)}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </ChartFrame>
  );
}

/** A reference line drawn across a plot, and the buckets it judges (design.md D5). */
export interface ChartThreshold {
  value: number;
  /** Names what the line is, for the `<title>` a pointer reveals. */
  label: string;
  /** Bucket labels at or above the threshold; each gets a marker on the bucket itself. */
  marked?: readonly string[];
}

/**
 * A nonzero segment never renders shorter than this. A 0px band is indistinguishable from an
 * absent one, and "absent is not zero" is the distinction the spec protects; the few pixels this
 * adds to a stack are bounded and the value table carries the exact figure either way.
 */
const MIN_SEGMENT_HEIGHT = 2;

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
  max,
  threshold,
}: {
  title: string;
  description?: string;
  series: readonly ChartSeries[];
  format: (value: number | null) => string;
  note?: ReactNode;
  /**
   * The plot's ceiling, where the chart knows it — a share chart's is 1. Inferring it from the
   * observed totals lets one bucket's rounding drift rescale every other bucket (design.md D3).
   */
  max?: number;
  threshold?: ChartThreshold | null;
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
  const ceiling = max ?? niceMax(totals);
  const plotWidth = VIEW_WIDTH - PADDING.left - PADDING.right;
  const plotHeight = VIEW_HEIGHT - PADDING.top - PADDING.bottom;
  const slot = plotWidth / points.length;
  const barWidth = Math.max(2, slot * 0.7);
  const id = chartId(title);
  const hatchId = `hatch-${id}`;
  const textureId = `texture-${id}`;
  const uncovered = points.filter((point) => point.uncovered).length;
  const marked = new Set(threshold?.marked ?? []);
  const y = (value: number) => PADDING.top + plotHeight - (value / ceiling) * plotHeight;
  const gridValues = Array.from(
    { length: GRID_DIVISIONS },
    (_, i) => (ceiling * (i + 1)) / GRID_DIVISIONS,
  );
  const labelStep = Math.max(1, Math.ceil(points.length / 6));
  const labelled = points
    .map((_, index) => index)
    .filter(
      (index) =>
        index === points.length - 1 ||
        (index % labelStep === 0 && points.length - 1 - index > labelStep / 2),
    );

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
        <SeriesTextures prefix={textureId} />
        {/* Drawn under the bars: a scale to read a segment's height against. */}
        {gridValues.map((value) => (
          <g key={`g-${value}`}>
            <line
              className="chart-grid"
              x1={PADDING.left}
              y1={y(value)}
              x2={VIEW_WIDTH - PADDING.right}
              y2={y(value)}
            />
            <text x="4" y={y(value) + 4} className="chart-axis">
              {format(value)}
            </text>
          </g>
        ))}
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
            // Absent is drawn as nothing at all; zero is drawn as a zero-height segment. The two
            // must not converge on the same picture.
            if (value === null || value === undefined) return null;
            const encoding = seriesEncoding(seriesIndex);
            const scaled = (value / ceiling) * plotHeight;
            const height = value === 0 ? 0 : Math.max(MIN_SEGMENT_HEIGHT, scaled);
            const rect = (
              <rect
                key={`${entry.name}-${point.label}`}
                className={`chart-mark chart-mark-${encoding.key}`}
                x={left}
                y={PADDING.top + plotHeight - offset - height}
                width={barWidth}
                height={Math.max(0, height)}
                fill={`url(#${textureId}-${encoding.texture})`}
                opacity={encoding.opacity}
                stroke="var(--surface)"
                strokeWidth={0.5}
              >
                <title>{`${entry.name} · ${point.label}: ${format(value)}`}</title>
              </rect>
            );
            offset += height;
            return rect;
          });

          const body = (
            <g key={point.label}>
              {segments}
              {marked.has(point.label) ? (
                // Which bucket, marked on the bucket rather than by a colour change: the rule
                // below says how far above the threshold it sits (design.md D5).
                <path
                  className="chart-bucket-mark"
                  d={`M${left + barWidth / 2},${PADDING.top + 9} l4,-7 l-8,0 z`}
                  fill="var(--warn)"
                >
                  <title>{`${point.label} is at or above the ${threshold!.label}.`}</title>
                </path>
              ) : null}
            </g>
          );
          return point.href ? (
            <Link key={`l-${point.label}`} href={point.href}>
              {body}
            </Link>
          ) : (
            body
          );
        })}
        {threshold ? (
          <g>
            <line
              className="chart-threshold"
              x1={PADDING.left}
              y1={PADDING.top + plotHeight - (threshold.value / ceiling) * plotHeight}
              x2={VIEW_WIDTH - PADDING.right}
              y2={PADDING.top + plotHeight - (threshold.value / ceiling) * plotHeight}
            >
              <title>{`${threshold.label}: ${format(threshold.value)}`}</title>
            </line>
            {/*
             * Labelled in the axis gutter rather than on the plot: a caption across the plot
             * lands on top of whichever bucket happens to be there, and the rule's own `<title>`
             * and the note below carry the full wording.
             */}
            <text
              className="chart-axis chart-threshold-label"
              x="4"
              y={PADDING.top + plotHeight - (threshold.value / ceiling) * plotHeight - 3}
            >
              {format(threshold.value)}
            </text>
          </g>
        ) : null}
        <line
          x1={PADDING.left}
          y1={PADDING.top + plotHeight}
          x2={VIEW_WIDTH - PADDING.right}
          y2={PADDING.top + plotHeight}
          stroke="var(--border)"
        />
        <text x="4" y={PADDING.top + plotHeight + 4} className="chart-axis">
          0
        </text>
        {labelled.map((index) => (
          <text
            key={`x-${points[index]!.label}`}
            x={PADDING.left + index * slot + slot / 2}
            y={VIEW_HEIGHT - 8}
            textAnchor="middle"
            className="chart-axis"
          >
            {points[index]!.label}
          </text>
        ))}
      </svg>
      <Legend series={series} kind="fill" />
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
