## Why

The chart suite shipped in `add-delivery-metrics-suite` renders incorrectly in ways that make three
of the four series charts unreadable, and one specified scenario was never implemented.

Observed on `/w/[id]/me` over a weekly period:

- **PR throughput draws nothing at all.** Its axis reports a real maximum, so the data is there;
  the line is absent because the series has one non-null bucket and `LineChart` strokes only
  `<path>` runs. A run of one point emits a bare `M x,y` — a moveto with no lineto — which renders
  as nothing. There are no point markers to fall back on. Any isolated bucket in any line chart is
  silently invisible, which is the exact failure the "absent values are gaps, never zeros" rule
  exists to prevent: a gap that swallows the value beside it reads as no data rather than as data.
- **The churn axis reads 200% and every bar is drawn at half height.** Each churn share is rounded
  to three decimals independently (`series.ts:234`), so the three can sum to `1.001`. `niceMax`
  then rounds that up to `2`. A single bucket one part in a thousand over the whole rescales every
  bar in the chart. `pr-metrics` requires that "the three shares SHALL sum to the whole"; the
  presentation layer has no reason to ask what the maximum of a share chart is.
- **The legend describes a different chart than the one drawn.** `StackedBarChart` distinguishes
  series by fill opacity (1.0 / 0.75 / 0.5 of one accent colour), while `Legend` renders line
  swatches distinguished by border-style (solid / dashed / dotted), all in the same colour. Nothing
  connects a legend entry to a bar segment. The `strokeDasharray` the rects do carry is drawn in
  the surface colour at 0.5px — invisible by construction. This defeats the "readable without
  relying on color alone" requirement while appearing to satisfy it.
- **The rework threshold is never marked on the chart.** `analytics-dashboard` specifies that a
  bucket above the needs-focus rework threshold "is marked against that threshold on the chart".
  The implementation lists offending bucket labels in a prose note instead; the chart itself has no
  threshold rule and no per-bucket marker. `refactor_rate`, seeded in `0014_benchmarks.sql` with a
  full tier band, is read by no code at all.

Separately, the personal view passes only `buckets` to every chart, so it loses drill-through, the
churn coverage statement, and the shares/lines toggle — all of which are neutral facts it is
entitled to show.

**A constraint this change deliberately honours rather than fixes.** The personal view's omission of
benchmark tiers is correct and stays. `docs/dignity-review.md` records that the only comparison
offered to an individual is against their own previous period, "never against a colleague or a team
norm" — and a published industry tier is a norm. Benchmark tiering belongs on the team view, where
it is already specified and half-built. This change makes that omission explicit in the spec so it
cannot be "fixed" later by someone reading the two views as inconsistent.

## What Changes

**Chart rendering** (`src/ui/charts.tsx`)
- `LineChart` draws a point marker for every non-null value, so a bucket whose neighbours are absent
  is visible. A one-point series renders as a point rather than as nothing.
- `StackedBarChart` distinguishes series by a fill **pattern** (hatch direction/density) as well as
  opacity, and `Legend` renders swatches in the encoding the chart actually uses — a filled swatch
  for bar charts, a line swatch for line charts. Legend and mark share one source of truth.
- Charts over a share-valued metric are scaled to a known ceiling of 1 rather than to `niceMax` of
  the observed totals, so rounding drift cannot rescale the plot.
- A stacked bar whose segments round to a sliver still renders at a minimum legible height, or the
  bucket states that a segment is too small to draw — a 0.4% rework share must not become a
  0-pixel invisible band.

**Churn judgment** (`src/ui/metric-charts.tsx`, team view)
- The needs-focus rework threshold is drawn as a horizontal rule on the churn chart, and a bucket at
  or above it carries a marker on the bucket itself. The prose note stays as the accessible text
  equivalent rather than as the only signal.
- `refactor_rate` gains the same benchmark treatment as `rework_rate`, so the seeded tier band stops
  being dead data.
- The churn chart states the direction of each ratio — that lower rework and lower refactor are the
  published-better end — so a viewer can tell what the composition means without leaving the page.

**Share rounding** (`src/analysis/series.ts`)
- Churn shares are derived so that the three sum to exactly the whole, honouring the `pr-metrics`
  invariant at the point where it is currently broken by independent rounding.

**Personal view** (`app/w/[workspaceId]/me/page.tsx`)
- Charts receive drill-through, the churn coverage start, and the shares/lines toggle.
- Charts do **not** receive benchmark tiers or the rework threshold, and the spec records that this
  is a dignity constraint rather than an oversight.

## Capabilities

### New Capabilities

None. Every behavior here is already owned by an existing capability.

### Modified Capabilities

- `analytics-dashboard`: chart rendering requirements gain explicit obligations for an isolated
  value, for share-valued scaling, and for legend/mark correspondence; the rework-threshold
  scenario is restated as a chart marking rather than a note; the personal view's exclusion of
  benchmark tiers becomes a stated requirement rather than an implementation accident.
- `pr-metrics`: the "three shares sum to the whole" requirement gains a scenario covering rounding,
  so the invariant is testable rather than aspirational.

## Impact

**Code**
- `src/ui/charts.tsx` — `LineChart`, `StackedBarChart`, `Legend`, `niceMax` call sites.
- `src/ui/metric-charts.tsx` — `ChurnChart` threshold rendering and refactor benchmark.
- `src/analysis/series.ts` — churn share derivation (`share()` at :234).
- `app/w/[workspaceId]/me/page.tsx` — chart props.
- `app/w/[workspaceId]/page.tsx` — passes the refactor threshold alongside the rework one.
- `app/globals.css` — legend swatch variants, SVG fill patterns, threshold rule styling.

**Data**
- No migration. `benchmark_thresholds` already carries `refactor_rate`; this change reads it.
- No recompute. Churn share derivation changes the third decimal of a presentation value, not a
  stored metric definition — `COMPUTED_VERSION` is unchanged.

**Tests**
- Chart primitives need cases for a one-point series, an isolated point between gaps, shares
  summing to 1.001, and legend/mark correspondence.
- `tests/surfaces/dignity.test.ts` gains an assertion that the personal view passes no benchmark
  assignment to any chart, so the constraint is enforced rather than documented.

**Not in scope**
- No charting library. The reasons in `charts.tsx`'s header — server rendering, no client bundle,
  values as text, gaps as gaps — are unchanged by these defects.
- No new metric definitions, no ingestion change, no change to what churn measures.
