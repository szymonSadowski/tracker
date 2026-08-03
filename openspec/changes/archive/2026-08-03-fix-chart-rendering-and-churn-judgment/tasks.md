## 1. Failing tests first

These pin the four defects before anything is changed, so each fix is verified by a test that was
red. All in `tests/surfaces/charts.test.ts` unless stated.

- [x] 1.1 `LineChart` with a series of one non-null bucket among five renders a visible mark for
      that bucket (currently: no drawn element at all)
- [x] 1.2 `LineChart` with values in buckets 0, 2, and 4 and gaps between renders three marks and
      no connecting segment across a gap
- [x] 1.3 `StackedBarChart` over shares that sum to 1.001 scales the plot to 100%, not 200%, and
      draws full-height stacks
- [x] 1.4 A stacked chart's legend swatch for each series carries the same non-color encoding as
      that series' marks — assert the shared descriptor, not the rendered pixels
- [x] 1.5 `ChurnChart` in shares mode with a bucket above the needs-focus rework threshold emits a
      threshold rule element and a marker on that bucket, not only the prose note
- [x] 1.6 In `tests/analysis/`, churn shares for an even three-way split sum to exactly 1 and none
      exceeds 1
- [x] 1.7 In `tests/surfaces/dignity.test.ts`, no personal-scoped page passes a benchmark
      assignment or a threshold into a chart component

## 2. Share derivation (design D4)

- [x] 2.1 Replace the independent `share()` at `src/analysis/series.ts:234` with largest-remainder
      rounding across the three churn components
- [x] 2.2 Keep the absent case absent: `churnTotal === 0` still yields `null` for all three, never
      zeros
- [x] 2.3 Confirm `COMPUTED_VERSION` is untouched and no recompute is implied — shares are derived
      on read, `pr_analysis` is unchanged

## 3. Chart primitives (design D1, D2, D3)

- [x] 3.1 Introduce the single per-series encoding descriptor in `src/ui/charts.tsx`, replacing the
      `SERIES_PATTERNS` / `DASH_ARRAYS` / `.chart-key-*` split; give it a `kind` of line or fill
- [x] 3.2 Define the SVG `<pattern>` fills for series textures alongside the existing `Hatch`, ids
      namespaced per chart as `Hatch` already does
- [x] 3.3 `Legend` takes the chart's `kind` and renders a line swatch or a filled, textured swatch
      to match; delete the border-style-only CSS keys
- [x] 3.4 `LineChart` emits a point marker at every non-null value, keeping the existing run/path
      splitting untouched
- [x] 3.5 `StackedBarChart` fills segments with the series texture over the existing opacity step,
      and drops the invisible `strokeDasharray`-in-surface-colour on the rects
- [x] 3.6 `StackedBarChart` accepts an optional explicit `max` and uses it in place of
      `niceMax(totals)` when given
- [x] 3.7 Apply a minimum legible height to a nonzero segment, and keep an absent segment absent —
      the two must stay visually distinct
- [x] 3.8 Update `app/globals.css`: legend swatch variants for both kinds, threshold rule styling,
      and removal of the dead `.chart-key-dashed/dotted/dashdot` rules

## 4. Churn chart judgment and naming (design D5, D6)

- [x] 4.1 `ChurnChart` passes `max={1}` in shares mode and omits it in lines mode
- [x] 4.2 Draw the needs-focus rework threshold as a horizontal rule on the plot in shares mode; in
      lines mode state that the threshold is not shown rather than omitting it silently
- [x] 4.3 Mark each bucket at or above the threshold on the bucket itself; keep the existing prose
      note as the text equivalent
- [x] 4.4 Read the `refactor_rate` needs-focus threshold in `app/w/[workspaceId]/page.tsx` beside
      the existing `rework_rate` read, and pass it through
- [x] 4.5 Give the refactor share a `BenchmarkTier` in the churn note, so the seeded band stops
      being dead data
- [x] 4.6 Retitle the chart to name the composition, and label the rework band as code churn; state
      for both benchmarked bands that the published study treats lower as better, attributed to the
      study rather than to the workspace
- [x] 4.7 State the rework recency window from workspace settings (`reworkRecencyDays`, default 21)
      in the chart's description, so "recently written" has a number

## 5. Personal view (design D7)

- [x] 5.1 `app/w/[workspaceId]/me/page.tsx` passes `drillThrough` to `ThroughputChart`,
      `CycleTimePhaseChart`, and `ChurnChart`, scoped to the viewer's own pull requests
- [x] 5.2 Pass `coveredFrom` to `ChurnChart` from the file-diff coverage the team view already reads
- [x] 5.3 Wire the shares/lines toggle with a `me`-scoped href
- [x] 5.4 Leave `benchmark` and `reworkThreshold` unpassed, with a comment naming
      `docs/dignity-review.md` as the reason so the asymmetry reads as intent

## 6. Documentation

- [x] 6.1 `docs/metrics.md` — adopt the composition/churn vocabulary from D6 and state the benchmark
      direction for both churn ratios
- [x] 6.2 `docs/dignity-review.md` — record in the surface-by-surface table that the personal view
      withholds benchmark tiers by rule, and that a test enforces it
- [x] 6.3 Note the third-decimal share change from task 2.1 in the change's release note

## 7. Verification

- [x] 7.1 Every test from section 1 passes
- [x] 7.2 `npm test`, `npm run lint`, `npm run typecheck` clean
- [x] 7.3 Render `/w/[id]` and `/w/[id]/me` against seeded data and confirm by eye: throughput line
      visible with one populated bucket, churn axis at 100%, legend entries matching bar textures,
      threshold rule present on the team view and absent on the personal view
      — confirmed by rendering the chart components themselves over fixture-shaped buckets, under
      `app/globals.css`, in a browser; no ingested workspace was reachable to drive the live routes.
      The by-eye pass is what found the two defects recorded under design.md's resolved questions:
      the threshold caption landing on the last bucket, and the rule being unreadable against a
      rework band stacked on top.
- [x] 7.4 Resolve design.md's open question against the rendered team chart — whether the refactor
      threshold earns a second rule or stays tier-only
