## 1. Fix the absent-throughput defect

- [x] 1.1 Change `throughputPerContributor` in `src/analysis/series.ts` to be `null` only when
      `contributors === 0 && mergedCount === 0`; where `contributors === 0 && mergedCount > 0`,
      report `mergedCount` (D9)
- [x] 1.2 Apply the same rule to `throughputPerContributorDay`, dividing by the bucket's days
- [x] 1.3 Add `denominatorMissing: boolean` to `MetricBucket`, true for the inconsistent case
- [x] 1.4 Replace the "Absent, not zero" comment with one stating the amended rule and why the
      observed merges win over an empty denominator
- [x] 1.5 Surface `denominatorMissing` on the throughput chart as a note saying the figure is a
      count standing in for a rate, so a changed number is legible rather than silent

## 2. Personal throughput chart

- [x] 2.1 Give `ThroughputChart` a `variant` of `'per-contributor'` | `'count'` selecting the field,
      title, description, and number format (D8)
- [x] 2.2 Pass the benchmark tier only in the `'per-contributor'` variant
- [x] 2.3 Switch `app/w/[workspaceId]/me/page.tsx` to the `'count'` variant; leave the team view on
      `'per-contributor'`

## 3. Aggregate layer

- [x] 3.1 Add `MergeEvent` and `ContributorMergeEvents` types to `src/analysis/series.ts` — merge
      instant, pull request id, number, title, url, repository, and the author group's id and name
- [x] 3.2 Add `mergeEventSeries(scope, filter, options)` returning contributor groups plus
      `coverageStart`, mirroring `contributorThroughputSeries`'s shape and parameters
- [x] 3.3 Order groups by `lower(COALESCE(name, login))` and events by merge time; never by event
      count (D6)
- [x] 3.4 Omit contributors with no merged pull request in the period rather than returning an
      empty group
- [x] 3.5 Apply a defensive per-contributor `LIMIT` and return a `truncated` flag so a truncated
      series can say so rather than silently disagree with the headline count (D6)
- [x] 3.6 Extend the module header note to cover the new function under the same no-ranking ordering
      guarantee (the project design's D10)

## 4. Chart primitive

- [x] 4.1 Add `ChartEvent` and `ChartEventSeries` types to `src/ui/charts.tsx` (`at`, `value`,
      `label`, optional `href`) — do not touch `ChartPoint` or `LineChart` (D1)
- [x] 4.2 Add `StepChart`, positioning events as `(at - periodStart) / (periodEnd - periodStart)`
- [x] 4.3 Draw each series as a step path: horizontal to the next event's x, then vertical to its y
      (D2)
- [x] 4.4 Anchor the path at `(periodStart, 0)` and carry it to `(periodEnd, total)` (D3)
- [x] 4.5 Reuse `seriesEncoding` for stroke dash and `chart-mark-<key>` / `chart-key-<key>` classes
      so the legend matches the marks
- [x] 4.6 Wrap each drawn mark in an `<a>` with an SVG `<title>` naming `#<number> <title>` (D4)
- [x] 4.7 Render the visually-hidden value table as one row per event — number, title, merge time,
      running total (D4)
- [x] 4.8 Thin drawn marks to `MAX_EVENT_MARKS`, always keeping the first and last, while the path
      and the table stay complete (D5)
- [x] 4.9 Hatch and name any span of the period preceding `coverageStart`, reusing the existing
      hatch pattern
- [x] 4.10 Render a time axis with enough labelled positions to locate a point, formatted in the
      workspace time zone
- [x] 4.11 Handle the empty case with a message that states no merges rather than an empty period,
      and draw no line at zero
- [x] 4.12 Style the new marks and the step path in `app/globals.css`

## 5. Metric chart

- [x] 5.1 Add `CumulativeThroughputChart` to `src/ui/metric-charts.tsx`, mapping
      `ContributorMergeEvents` to `ChartEventSeries` with the running total as `index + 1`
- [x] 5.2 Give it a description stating it is the same merged count the headline reports, at
      per-pull-request resolution
- [x] 5.3 Surface the truncation flag from 3.5 as a chart note when set

## 6. Personal view

- [x] 6.1 Call `mergeEventSeries` on `app/w/[workspaceId]/me/page.tsx` with the viewer's
      contributor scope and the selected period
- [x] 6.2 Render `CumulativeThroughputChart` alongside the existing `ThroughputChart`
- [x] 6.3 Keep the no-activity copy consistent with the existing "this is a record, not a target"
      framing

## 7. Team view

- [x] 7.1 Call `mergeEventSeries` on `app/w/[workspaceId]/page.tsx` for the authors already
      resolved from `?authors=`, reusing the same cap of four (D10)
- [x] 7.2 Render the chart beside `ContributorThroughputChart` so both describe the same selection
- [x] 7.3 Preserve period, team, granularity, churn unit, and author selection in existing toggle
      links

## 8. Tests

- [x] 8.1 `tests/analysis/series.test.ts`: a bucket with merges and a zero denominator reports the
      merged count and sets `denominatorMissing`, rather than being absent — the reported defect
- [x] 8.2 A bucket with no merges and no contributors is still absent
- [x] 8.3 Summing a contributor-scoped period's buckets equals the merged count the tile reports,
      with a membership row starting after the period's first bucket
- [x] 8.4 `tests/surfaces/`: the personal view's throughput chart states counts, carries no
      benchmark tier, and does not describe itself as per contributor
- [x] 8.5 The team view's throughput chart still states the per-contributor rate and its tier
- [x] 8.6 `tests/analysis/series.test.ts`: event count equals the sum of the bucketed merged counts
      for the same scope and period
- [x] 8.7 Groups ordered by name while the contributor with the most events sorts last
- [x] 8.8 A contributor with no merged pull request in the period is absent from the series
- [x] 8.9 Events are ordered by merge time and carry the identity needed to link out
- [x] 8.10 `tests/surfaces/charts.test.ts`: the step path is horizontal-then-vertical, with no
      diagonal between events
- [x] 8.11 The path starts at zero at the period start and holds its final value to the period end
- [x] 8.12 With more events than `MAX_EVENT_MARKS`, every event still appears in the value table and
      in the path
- [x] 8.13 Each drawn mark links to its pull request and titles it by number and title
- [x] 8.14 A period beginning before coverage renders the uncovered span hatched and named
- [x] 8.15 An empty period renders the no-merges message and draws no line

## 9. Verification

- [x] 9.1 Run the full test suite and the linter
- [x] 9.2 Open both views on real data and confirm the cumulative line's final value equals the
      headline merged count for the same period
- [x] 9.3 On the reporting workspace, confirm the personal throughput chart now draws every bucket
      that holds merges — the membership row there starts 2026-08-02 while merges precede it, so
      this is the case that produced the single dot
