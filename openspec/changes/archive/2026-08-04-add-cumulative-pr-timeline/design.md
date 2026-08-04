## Context

See proposal.md — Why. Three existing constraints shape the whole design.

**Charts are server-rendered SVG with no hydration (D7).** There is no tooltip layer and no client
bundle. Anything a viewer learns by pointing at a mark has to come from a link, a native SVG
`<title>`, or the visually-hidden value table every chart already renders.

**`LineChart` is index-positioned.** `step = plotWidth / (points.length - 1)` and `x(index)`. Its
whole contract is that every series shares one bucket list, which is what lets the value table put
series in columns against one label column. An event chart has no shared label list — two authors'
merges land at different instants — so this is not a parameter that can be added to `LineChart`
without breaking what it guarantees.

**`ChartPoint` has no time.** It carries a label, a value, an `uncovered` flag, and an href. The
bucket's dates live in `MetricBucket` on the analysis side and are converted to labels at the chart
boundary.

**The defect this change also fixes.** `series.ts:300-302` reads *"Absent, not zero: a scope with no
active contributors has no rate to state"*, and returns `null` when `contributors === 0`.
`contributorDenominators` filters `workspace_memberships` by `filter.contributorId`, so on the
personal view the denominator is the viewer's own tenure fraction. Membership rows are written at
first sync — the reporting workspace has a single row starting `2026-08-02` — while ingested pull
requests reach further back. Every bucket ending before that date therefore yields `null`, and
`LineChart` draws `null` as a break in the path. The merges in those buckets are drawn nowhere, and
with one surviving bucket there is no segment to draw at all, which is the lone dot in the report.

## Goals / Non-Goals

**Goals:**

- One new chart primitive that positions points on a time scale, reusing `SERIES_ENCODINGS`,
  `ChartFrame`, the hatch pattern, and the value-table pattern so it is recognisably the same suite.
- A single aggregate function that both views call, so the personal and team charts cannot compute
  the metric differently.
- The cumulative total agreeing with the headline count by construction, not by two code paths
  happening to match.

**Non-Goals:**

- Changing `LineChart`, `StackedBarChart`, or `HistogramChart`. They keep their index positioning.
- Any zoom, brush, pan, or hover interaction. Those need hydration.
- Reusing the granularity selector. The event chart has no buckets, so granularity does not apply
  to it.

## Decisions

### D1: A separate `StepChart` primitive rather than a mode on `LineChart`

`LineChart` derives its x positions, its axis labels, and its value-table label column from
`series[0].points`. An event chart violates that in three ways at once: series have different
lengths, points have instants instead of ordinal labels, and the table needs a row per event rather
than a row per shared label.

Alternatives considered:

- *A `timeScale` flag on `LineChart`.* Every one of the three derivations becomes a branch, and the
  guarantee that a value-table column lines up with a label row becomes conditional. The bug class
  `fix-chart-rendering-and-churn-judgment` fixed — a legend and its marks disagreeing because two
  derivations drifted — is exactly what conditional derivations invite.
- *Pre-bucketing events at day granularity and reusing `LineChart`.* This is the current chart with
  a finer bucket. It re-introduces the thing being removed: a day with three merges is one point of
  height three, and the individual pull request is invisible again.

`StepChart` takes `ChartEventSeries[]`, where an event is `{ at: Date; value: number; label: string;
href?: string }`, plus the period's start and end. Positions are `(at - start) / (end - start)`.

### D2: The line is a step, not a slope

Between two merges the running total is genuinely constant. Interpolating a diagonal draws a value
the person never had at a time they did not have it — at any point mid-slope the chart asserts a
non-integer number of merged pull requests. `path` is therefore `H` to the next event's x, then `V`
to its y. The vertical is the pull request; the horizontal is the wait.

This also makes an inactive stretch read as a plateau rather than a gentle climb, which is the
honest shape.

### D3: The chart is anchored at both ends of the period

The path starts at `(periodStart, 0)` and is carried horizontally to `(periodEnd, total)` after the
last event. Without the trailing segment the line ends wherever the last merge fell, and a period
ending in three quiet weeks looks identical to one that ended at the last merge. Without the leading
anchor a first merge on day one has nothing to rise from.

The trailing anchor is what makes the final value the period total by construction, which is the
correctness condition the spec states.

### D4: Identity comes from `<title>`, the value table, and links — not a tooltip

Each event's mark is an `<a>` wrapping a `<circle>`, with a `<title>` naming `#<number> <title>`.
Native SVG `<title>` gives a hover string with no JavaScript, and the wrapping link is what makes
the point reachable by keyboard and by click. The visually-hidden table gets one row per event —
number, title, merge time, running total — which is what a screen reader reads and what satisfies
"values available as text".

Alternative considered: drilling through to the filtered pull request list, as the bucketed charts
do. Rejected because a point *is* one pull request; sending the viewer to a list filtered to a
one-second window to find it again is a worse answer than linking to it.

### D5: Marks thin, the line does not

Above roughly 60 events in the period the circles collide and the chart becomes a smear. The marks
are thinned to at most `MAX_EVENT_MARKS`, always keeping the first and last, while the path passes
through every event and the table lists every event. This is why the spec separates "drawn as
separate marks" from "the line passes through every event" — the guarantee is on the line and the
text, not on the circle count.

### D6: One SQL function, `mergeEventSeries`, returning grouped events

Signature mirrors `contributorThroughputSeries`: `(scope, filter, options)`. It returns
`{ contributors: Array<{ id, name, events: MergeEvent[] }>, coverageStart }`, ordered by
`lower(COALESCE(name, login))` — the same `ORDER BY` that enforces the project design's D10 (no
ranking of contributors), as amended by `add-per-author-throughput`. The personal view
calls it with a contributor-scoped filter and reads the single group.

No cumulative total is computed in SQL. The running sum is `index + 1` within a group; computing it
in a window function would put a second definition of "the total" in a place that could drift from
the count.

Row cap: the query is bounded by the period, and a period is bounded by the period selector, so an
unbounded fetch is not reachable from the UI. A defensive `LIMIT` per contributor is added anyway,
with the truncation surfaced in the chart note rather than silently dropping events — a chart whose
final value quietly disagreed with the headline would be the worst failure mode available here.

### D7: Membership masking does not apply

`contributorThroughputSeries` masks buckets before a contributor's membership start, so absence of
tenure is not drawn as absence of output. A cumulative event line has no such hazard: before a
person's first merge the line is flat at zero and there is nothing there to misread as a measured
value — the flat run is where the events aren't, not a claim of zero output over a period they
weren't present for. Adding a mask would mean not drawing the leading anchor, and then the line
would not start at zero, and D3 would not hold.

Coverage is different and is kept: an uncovered span is hatched and named, because there the data
is missing rather than the person.

### D8: The personal view drops the denominator rather than repairing it

`mergedCount` is already on `MetricBucket` and is already what the headline tile reads.
`ThroughputChart` takes a `variant` — `'per-contributor'` for the team view, `'count'` for the
personal view — selecting the field, the title, the description, and the format. The benchmark tier
is only passed in the per-contributor variant, since the published benchmark is stated per
contributor per day and has no meaning against a raw count; the personal view passes no benchmark
anyway, which the existing requirement already forbids.

Alternatives considered:

- *Keep the rate and fix the denominator.* Even with a correct denominator, one person's tenure
  fraction is a number between 0 and 1 that turns their count into a figure matching nothing else on
  the page. The rate is the wrong metric at this scope, not a miscomputed one.
- *Backdate `workspace_memberships.started_at` to first observed activity.* This is the real repair
  for the denominator and it would fix the personal view as a side effect, but it is an ingest
  change with a backfill, and it silently rewrites every historical per-contributor rate on the team
  view. Out of scope here, deliberately; D9 below stops the symptom without it.

### D9: A bucket with merges is never absent

The absence rule stays for its real case — no contributors and nothing merged means there is no rate
to state — but it may no longer erase a count. `throughputPerContributor` becomes `null` only when
`contributors === 0 && mergedCount === 0`. Where `contributors === 0 && mergedCount > 0` the inputs
are inconsistent, and the chosen resolution is to trust the thing actually observed: pull requests
merged. The bucket reports `mergedCount` as its rate, which is the value the rate would take at a
denominator of one.

`MetricBucket` gains `denominatorMissing: boolean` for that case, so the surface can say the figure
is a count standing in for a rate rather than presenting it as a computed rate. Silently returning
`mergedCount` under a "per contributor" label would trade a visible wrong answer for an invisible
one.

This is what makes the fix hold on the team view too, where the same membership backfill produces
the same zero denominators over early buckets — nobody has reported it there yet because the team
chart has more non-null buckets to draw a line through.

### D10: Team view reuses `?authors=`, capped at four

The selection, the cap, and the reasoning are `add-per-author-throughput`'s, unchanged: four series
encodings, so a fifth line repeats a dash pattern. The new chart sits beside the bucketed one and
reads the same `authors` list, so the two charts on the page always describe the same people.

## Risks / Trade-offs

- **A busy period draws a wall of circles.** → D5 thins the marks; the line and the table stay
  complete.
- **Cumulative lines make totals comparable at a glance, which is close to ranking.** → It is the
  same comparability four bars already have, and nothing in the system returns people ordered by
  the total. The `ORDER BY name` in D6 is the enforcement, as it was before. Accepted deliberately;
  the alternative is refusing the owner's request on a distinction the chart cannot actually hide.
- **A second chart of the same metric invites "which one is right?"** → They are the same numbers
  at two resolutions, and D3's trailing anchor makes the agreement structural. The chart's
  description says so explicitly.
- **Time positioning misreads across a DST boundary if done in JS.** → Positions are fractions of
  the period computed from absolute instants, so no calendar arithmetic happens client-side; only
  the axis labels are formatted, and those go through the same workspace time zone the buckets use.
- **A very long period compresses everything into a few pixels.** → Accepted. The period selector
  is the control for that, and it is the same trade-off the bucketed charts make.
- **D9 changes team-view numbers that people may have already read.** Early buckets that showed no
  point will now show one, and a saved screenshot will not match. → Real, and preferred to leaving
  merges undrawn. The `denominatorMissing` note says the figure is a count standing in for a rate,
  so the change is legible rather than silent.
- **D9 resolves an inconsistency rather than removing it.** A zero denominator over recorded merges
  still means the membership intervals are wrong; this change stops the wrongness from erasing
  output, but does not repair the intervals. → Explicitly out of scope, recorded here so the next
  reader does not mistake the symptom fix for the cure. Backdating memberships to first observed
  activity is the follow-up.
- **The personal and team throughput charts now plot different quantities under similar names.** →
  The variant sets the title and description, so each chart says which quantity it draws; and the
  personal view's count is the one that agrees with its own headline tile.

## Open Questions

None that change the specs, the approach, or the task breakdown.
