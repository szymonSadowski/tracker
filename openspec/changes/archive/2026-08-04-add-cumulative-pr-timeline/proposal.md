## Why

Every throughput surface today aggregates pull requests into buckets before drawing them. A viewer
sees that a week held six merges; they cannot see which six, or where inside the week they landed.
`add-per-author-throughput` made the count readable per person, but it kept the bucket as the
smallest unit, so the individual pull request — the thing a person actually did — is still not on
any chart.

The workspace owner asks for the pull request itself to be visible: a continuous line whose steps
are individual merges, so each merge's contribution to the period total is legible as a step rather
than inferred from a bar's height. That is a granularity change, not a metric change.

Investigating the request surfaced a defect on the same surface, which this change also fixes. On
the personal view the throughput chart plots `throughputPerContributor` — merged pull requests
divided by prorated contributors — but the personal view's scope is one person, so the denominator
is the viewer's own membership fraction. Two consequences follow:

- The normalization is meaningless at that scope. Dividing your own count by your own tenure
  fraction reports neither your output nor a rate anyone asked for.
- Worse, a bucket that ends before the viewer's `workspace_memberships.started_at` has a zero
  denominator, so the metric is absent, so the chart draws a gap — **even when pull requests
  merged in that bucket**. Membership rows are written when a workspace first syncs, while ingested
  history reaches further back, so this is the normal case rather than an edge case. Observed on
  the reporting workspace: the headline tile reads 12 merged pull requests while the chart's only
  point reads 9, with the remaining merges drawn nowhere at all.

A tile and a chart disagreeing about one metric is precisely what the rollup layer exists to
prevent; `series.ts` opens by stating that two surfaces showing the same metric cannot disagree.
Here they do. The lone dot the viewer sees is the visible symptom of merges being dropped.

## What Changes

- A **cumulative merged pull requests** chart is added: a monotonic step line over the selected
  period, rising by exactly one at each merge, plotted at real merge time rather than at a bucket
  index.
- The chart appears on the personal view scoped to the viewer's own merges, and on the team view as
  one line per author, driven by the `?authors=` selector `add-per-author-throughput` already
  built.
- The aggregate layer gains a per-merge series: an ordered list of merge events, each carrying the
  pull request's identity, so a step can be named rather than only counted.
- The chart primitives gain a time-positioned step line. Existing charts are unchanged; the current
  `LineChart` spaces points evenly by bucket index, which cannot place an event at an arbitrary
  instant.
- Each step names its pull request in the chart's value table and in a native SVG title, and links
  to that pull request. This stays within the no-hydration rule: no tooltip layer, no client
  bundle.
- **The personal view's throughput chart plots the viewer's own merged pull request count**, not a
  per-contributor rate. The per-contributor normalization stays on the team view, where a
  denominator greater than one means something.
- **A bucket with recorded merges is never absent.** The rollup layer keeps "no active contributors
  means no rate to state", but that rule may no longer erase a count that exists: where merges are
  recorded and the denominator is zero, the two are inconsistent and the count wins. This closes the
  same hazard on the team view without waiting for it to be reported there.

## What does not change

- **No new metric.** The y-axis is the same merged pull request count the bucketed chart draws;
  only its resolution changes. The last point of the cumulative line equals the period's headline
  merged count, and that equality is the chart's correctness condition.
- **No ranking.** Per-author series stay in name order, exactly as D10 was amended to permit. A
  cumulative line ends at a person's total, which makes "who is highest" legible on the chart — but
  it is legible the same way four bars of different heights already are, and nothing in the system
  returns people ordered by that height.
- **No per-person latency, size, or churn.** A step is worth one merge whatever the merge contained.
  Weighting steps by lines changed would put per-person size on a team surface, which D10 still
  forbids.
- The personal view still presents no benchmark tier for the viewer's own values.

## Capabilities

### New Capabilities

None. This is a finer resolution of a metric both capabilities already define.

### Modified Capabilities

- `analytics-dashboard`: adds the requirement that merged throughput is presentable per pull
  request as a cumulative line on the personal and team views; extends the "readable without
  relying on color alone" requirement to cover a chart whose points are events rather than buckets
  (its value table is per event, and its x-axis is a time scale that must remain labelled); and
  amends "the personal view shows one's own work" to require the viewer's own count rather than a
  rate normalized by a denominator of themselves.
- `metric-aggregation`: adds the requirement that merged pull requests are available as an ordered
  event series identifying each pull request, within the existing prohibition on ranking
  individuals; and amends "PR throughput is normalized per active contributor" so that an absent
  rate may never suppress a merged count that exists.

## Impact

- `src/analysis/series.ts` — new `mergeEventSeries`, alongside the existing bucketed functions; the
  `throughputPerContributor` absence rule changes where merges exist.
- `src/ui/charts.tsx` — new time-scaled step chart primitive; `ChartPoint` and `LineChart` untouched.
- `src/ui/metric-charts.tsx` — new `CumulativeThroughputChart`; `ThroughputChart` gains an own-count
  presentation for contributor scope.
- `app/w/[workspaceId]/page.tsx` — team view, reusing the existing `?authors=` selection.
- `app/w/[workspaceId]/me/page.tsx` — personal view, viewer-scoped.
- `app/globals.css` — styles for the new marks.
- Tests under `tests/` for the series function and the chart.
- No schema migration: merge timestamps and pull request identity are already stored.
