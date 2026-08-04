## Purpose

Presents the derived pull request metrics to the people they describe — a team view of aggregate
throughput and latency, a personal view of one's own work, and a pull request list underneath both
— while being honest about incomplete data and refusing to rank individuals against each other.

## Requirements

### Requirement: The team view presents aggregates, not individual rankings

The system SHALL present team metrics as aggregates over the team's pull requests for a selected
period, and SHALL NOT present a ranking of team members by any throughput or latency metric. The
team view SHALL present those aggregates both as current-period values and as a trend over the
period buckets, so a viewer sees direction and not only level.

One per-person comparison is permitted and no other: merged pull request counts per bucket, as a
series per author. It SHALL be ordered by name and never by the metric, and no latency, size,
churn, or review metric SHALL be offered per person on a team-scoped surface. The system SHALL
still refuse to order team members by any productivity metric, including that count.

#### Scenario: A member opens the team view

- **WHEN** a member opens a team view for the last 30 days
- **THEN** they see the team's merged pull request count, PR throughput per contributor, median
  cycle time with its phase breakdown, median time to first review, code churn composition, and
  change size distribution for that period

#### Scenario: Per-person ordering is requested

- **WHEN** any client requests team members ordered by cycle time, throughput, or a comparable
  productivity metric
- **THEN** no such ordering is available from the system

#### Scenario: A member reads a trend

- **WHEN** a member views a team metric over a multi-bucket period
- **THEN** they see the value per bucket as a series alongside the headline value for the period

#### Scenario: A per-person latency metric is requested

- **WHEN** any client requests cycle time, review depth, or churn broken down per team member on a
  team-scoped surface
- **THEN** no such breakdown is available from the system

### Requirement: Throughput is available as a series per team member

The system SHALL present merged pull request counts per bucket as one series per author, over the
same period and granularity as the team's other trend charts. The series SHALL be returned in name
order. The viewer SHALL choose which authors are drawn, and that choice SHALL be part of the
view's address so the resulting chart can be linked to.

Only authors with at least one merged pull request in the period SHALL appear. A bucket the author
merged nothing in SHALL be a zero, and a bucket that ended before the author joined the workspace
SHALL be a gap, so that absence of tenure is never drawn as absence of output.

The number of series drawn at once SHALL be limited to the number the system can distinguish
without relying on colour, and the surface SHALL state that limit when the viewer reaches it.

#### Scenario: A viewer opens the per-author chart

- **WHEN** a viewer opens the team view for a period in which three people merged pull requests
- **THEN** they see a line per author, labelled by name, over the same buckets as the other trends

#### Scenario: A viewer changes which authors are drawn

- **WHEN** a viewer deselects an author
- **THEN** that line is removed and the rest are unchanged
- **AND** the resulting view has its own address

#### Scenario: A viewer reaches the series limit

- **WHEN** a viewer has selected as many authors as the chart can distinguish without colour
- **THEN** selecting a further author is not offered
- **AND** the surface states why

#### Scenario: An author merged nothing in a bucket

- **WHEN** an author in the chart merged no pull request in one bucket of the period
- **THEN** that bucket reads as zero for that author rather than as a gap

#### Scenario: An author joined mid-period

- **WHEN** an author's workspace membership began after the start of the selected period
- **THEN** the buckets that ended before they joined are gaps rather than zeros

#### Scenario: An author merged nothing in the whole period

- **WHEN** an author merged no pull request anywhere in the selected period
- **THEN** they do not appear in the chart at all

### Requirement: The personal view shows one's own work

The system SHALL provide each user a view of their own pull requests and metrics over a selected
period, including a trend across periods. The personal view SHALL NOT present a benchmark tier, a
benchmark threshold, or any other comparison against an industry or team norm for the viewer's own
metrics; its only comparison SHALL be against the viewer's own previous period. It SHALL present
the same descriptive and coverage information as the team view, including drill-through to the
pull requests behind a bucket, the coverage a metric's data reaches, and the same presentation
toggles.

Throughput on the personal view SHALL be the viewer's own count of merged pull requests, not a rate
normalized by a contributor denominator. A denominator whose only member is the viewer describes
the viewer's tenure rather than their output, and dividing by it reports a figure that matches
neither the count the same view states nor any rate the viewer can act on.

#### Scenario: A user opens their personal view

- **WHEN** a signed-in contributor opens their personal view
- **THEN** they see their own merged pull request count, their cycle time, and how those compare
  to their own previous period

#### Scenario: A user reads their throughput trend

- **WHEN** a contributor reads the throughput chart on their personal view
- **THEN** each bucket states how many pull requests they merged in it
- **AND** the sum over the period's buckets equals the merged pull request count the same view
  states for that period

#### Scenario: A user has no activity in the period

- **WHEN** a contributor has no pull requests in the selected period
- **THEN** the view states that plainly without implying underperformance

#### Scenario: A benchmarked metric appears on the personal view

- **WHEN** a metric with configured benchmark thresholds is shown on a contributor's personal view
- **THEN** no tier, threshold, or band is presented for that contributor's own value
- **AND** the same metric on the team view still presents its tier

#### Scenario: A user drills into their own chart

- **WHEN** a contributor selects a bucket on a chart in their personal view
- **THEN** they see their own pull requests behind that bucket

#### Scenario: A user reads their churn chart over partial coverage

- **WHEN** a contributor opens their churn chart over a period only partly covered by per-file diff
  data
- **THEN** the chart states from when churn data exists, as it does on the team view

### Requirement: Viewing another person's detail requires being a workspace owner

The system SHALL restrict per-contributor detail views to workspace owners and to the contributor
themselves.

#### Scenario: A member opens a colleague's detail

- **WHEN** a workspace member who is not an owner requests another contributor's detail view
- **THEN** the request is rejected

### Requirement: Time period is an explicit control

The system SHALL let the viewer choose the time period for every metric surface, and SHALL state
the active period on the surface. When the chosen period extends earlier than the workspace's
synced coverage, the surface SHALL say so rather than presenting the uncovered portion as though it
held no activity.

#### Scenario: A viewer changes the period

- **WHEN** a viewer switches from 30 days to 7 days
- **THEN** all metrics on the surface recompute for the new period
- **AND** the displayed period label reflects the change

#### Scenario: A viewer selects a period reaching before synced coverage

- **WHEN** a viewer chooses a period beginning earlier than the workspace's coverage start
- **THEN** the surface states that the period is only partially covered, and from when data exists
- **AND** the viewer is offered the history sync that would extend coverage

### Requirement: The pull request list is filterable and links out to GitHub

The system SHALL present the underlying pull requests for any metric surface, filterable by
repository, author, team, and state, with each entry linking to the pull request on GitHub.

#### Scenario: A viewer drills into a metric

- **WHEN** a viewer opens the pull request list from a team metric
- **THEN** the list contains exactly the pull requests that metric was computed from

#### Scenario: A viewer opens a pull request

- **WHEN** a viewer selects a pull request entry
- **THEN** they are taken to that pull request on GitHub

### Requirement: Absent metrics are shown as absent

The system SHALL display a metric that could not be computed as unavailable, and SHALL NOT render
it as zero.

#### Scenario: A pull request was merged without review

- **WHEN** a pull request with no review appears in a list
- **THEN** its time to first review is shown as unavailable rather than as zero

#### Scenario: An aggregate has partial coverage

- **WHEN** an aggregate is computed over a set where some pull requests lack the underlying metric
- **THEN** the surface indicates how many pull requests the aggregate covers

### Requirement: Data completeness is visible

The system SHALL indicate when the data behind a surface is incomplete or stale, and SHALL show
when the workspace last synced. Incompleteness SHALL distinguish data that is still arriving from
data that was never requested. A chart SHALL carry the same honesty as a tile: a series whose
buckets are unevenly covered SHALL say so rather than rendering a dip caused by missing data as
though it were a change in behavior.

#### Scenario: Backfill is still running

- **WHEN** a viewer opens a surface while a repository's backfill is in progress
- **THEN** the surface states that historical data is still loading and which repositories are
  affected

#### Scenario: Sync has been failing

- **WHEN** the workspace's most recent syncs have failed
- **THEN** the surface shows that data may be stale and when it last synced successfully

#### Scenario: A history sync is running

- **WHEN** a viewer opens a surface while a history sync is ingesting older pull requests
- **THEN** the surface states that historical data is still being added and how far back it
  currently reaches
- **AND** metrics for periods inside existing coverage are presented normally

#### Scenario: Coverage is complete but the period is empty

- **WHEN** a period falls entirely inside the workspace's synced coverage and contains no pull
  requests
- **THEN** the surface presents the period as genuinely empty, not as missing data

#### Scenario: A chart's earlier buckets are outside coverage

- **WHEN** a series extends earlier than the workspace's coverage start
- **THEN** the uncovered buckets are visually distinguished from covered ones and labeled as
  uncovered
- **AND** they are not drawn as zero

#### Scenario: A churn series predates file-level coverage

- **WHEN** a viewer opens a churn chart over a period only partly covered by per-file diff data
- **THEN** the chart states from when churn data exists and marks the earlier buckets as uncovered

#### Scenario: Classification is still running

- **WHEN** a viewer opens a work-mix surface while classification is still processing the period
- **THEN** the surface states how many pull requests remain unclassified
- **AND** presents the ratios over the classified pull requests rather than withholding the surface

### Requirement: Cold start states name the missing prerequisite

The system SHALL, when a surface has no data, state the specific reason and offer the action that
resolves it.

#### Scenario: No repositories are selected

- **WHEN** a workspace has an installation but no repositories in scope
- **THEN** the surface says so and links to repository selection

#### Scenario: No teams exist yet

- **WHEN** a workspace has contributors but no teams
- **THEN** the team surface says so and offers to create a team

### Requirement: Every rollup metric is available as a time series chart

The system SHALL render each aggregate metric as a chart over the selected period at a granularity
the viewer controls, and SHALL let the viewer switch between day, week, and month granularity
without changing the period. A value present in a bucket SHALL be visible regardless of whether the
buckets adjacent to it hold values, so that a gap beside a value never consumes the value.

#### Scenario: A viewer opens a metric chart

- **WHEN** a viewer opens the throughput chart for a 90-day period
- **THEN** they see one point per bucket at the selected granularity, labeled with its bucket

#### Scenario: A viewer changes granularity

- **WHEN** a viewer switches a chart from weekly to monthly
- **THEN** the same period is re-bucketed and the chart redraws
- **AND** the period selection is unchanged

#### Scenario: A bucket has no computable value

- **WHEN** a bucket's metric is absent
- **THEN** the chart shows a gap at that bucket rather than a zero point

#### Scenario: Only one bucket in a series has a value

- **WHEN** a series over several buckets has a computable value in exactly one of them
- **THEN** that value is drawn and readable on the chart
- **AND** the chart is not blank

#### Scenario: A value sits between two absent buckets

- **WHEN** a bucket with a computable value has an absent bucket on either side
- **THEN** that value is drawn as a point rather than omitted for want of a neighbour to connect to

### Requirement: Cycle time is presented as its phases

The system SHALL present cycle time as a composition of coding, pickup, and review time — as a
stacked series over buckets and as a breakdown of the headline value — so a viewer can see which
phase accounts for the total.

#### Scenario: A viewer opens the cycle time chart

- **WHEN** a viewer opens the cycle time chart for a team
- **THEN** each bucket shows coding, pickup, and review time stacked to the bucket's cycle time

#### Scenario: A phase is uncomputable for part of the period

- **WHEN** a bucket's pull requests largely lack a computable coding time
- **THEN** the bucket reports how many pull requests its decomposition covers
- **AND** the missing phase is not drawn as zero

#### Scenario: A viewer drills into a phase

- **WHEN** a viewer selects a phase in a bucket
- **THEN** they see the pull requests that phase was computed from

### Requirement: Code churn is presented as a composition over time

The system SHALL present the new code, refactor, and rework shares as a composition per bucket, both
as shares of the whole and as absolute line counts. The surface SHALL name what the composition
measures and which direction each benchmarked band is better in, so that a viewer can read the
chart without prior knowledge of the metric's definition. Where the surface uses the word "churn"
for the three-way composition, it SHALL distinguish that composition from the rework band, which is
the component the published benchmarks score.

#### Scenario: A viewer opens the churn chart

- **WHEN** a viewer opens the churn chart for a repository over 6 months
- **THEN** each bucket shows new code, refactor, and rework as shares summing to the whole

#### Scenario: A viewer switches to absolute values

- **WHEN** a viewer switches the churn chart from shares to line counts
- **THEN** each bucket shows the three categories as absolute line counts

#### Scenario: Rework rises sharply in a bucket

- **WHEN** a bucket's rework share exceeds the needs-focus benchmark threshold
- **THEN** the threshold is drawn on the chart itself as a reference against which bucket heights
  can be read
- **AND** the bucket at or above it carries a marker on the bucket
- **AND** the same information is available as text for a viewer who cannot read the mark

#### Scenario: A viewer asks what a high rework share means

- **WHEN** a viewer reads the churn chart
- **THEN** the surface states that rework counts lines rewritten within the workspace's rework
  recency window or after first review, and that the published benchmark treats a lower share as
  better
- **AND** it states the same for refactor
- **AND** it attributes the direction to the published study rather than presenting it as a target
  the workspace set

#### Scenario: A segment is too small to draw

- **WHEN** a bucket's segment is a nonzero share too small to render at a legible height
- **THEN** the segment is still distinguishable from an absent segment
- **AND** its value remains available as text

### Requirement: Commit activity is presented as its own series

The system SHALL present default-branch commit activity as a series over the selected period,
filterable by repository and team, independent of pull request activity.

#### Scenario: A viewer opens the commit activity chart

- **WHEN** a viewer opens commit activity for a workspace over 90 days
- **THEN** they see commit counts per bucket across in-scope repositories

#### Scenario: Commits land outside pull requests

- **WHEN** commits are pushed directly to the default branch in a period
- **THEN** they appear in commit activity for that period

### Requirement: Skewed metrics are presented as distributions

The system SHALL present pull request size and each latency metric as a distribution over the
selected period, alongside its percentile summary, rather than as a single average.

#### Scenario: A viewer opens the size distribution

- **WHEN** a viewer opens the pull request size view for a team
- **THEN** they see the distribution across size bands and the p50, p75, and p90 values

#### Scenario: A distribution has a long tail

- **WHEN** a latency distribution contains extreme outliers
- **THEN** the summary presents percentiles, and the mean is labeled as such where shown

#### Scenario: The sample is too small

- **WHEN** a period contains fewer pull requests than the minimum sample size
- **THEN** the surface says the sample is too small rather than drawing a distribution

### Requirement: Benchmarked metrics show their tier and thresholds

The system SHALL show, for each metric with configured benchmarks, the tier the current value falls
into and the thresholds that define the tiers, and SHALL make clear that the comparison is against
published industry data rather than a target the workspace set. A metric whose thresholds are
configured SHALL be surfaced on at least one team-scoped surface, so that a seeded benchmark is
never carried without being read.

#### Scenario: A viewer reads a benchmarked metric

- **WHEN** a viewer opens a metric with configured benchmarks
- **THEN** they see its tier, the threshold boundaries, and the source of the benchmark

#### Scenario: A metric has no benchmark

- **WHEN** a metric has no configured benchmark
- **THEN** no tier is shown and none is implied

#### Scenario: A benchmark is configured for the refactor share

- **WHEN** a viewer opens the churn chart on a team-scoped surface
- **THEN** the refactor share carries its tier and thresholds as the rework share does

### Requirement: The work mix surface presents classified work types

The system SHALL present the distribution of work types over the selected period, together with the
defect ratio and innovation ratio, and SHALL let a viewer drill into the pull requests behind any
segment.

#### Scenario: A viewer opens the work mix

- **WHEN** a viewer opens the work mix for a team over a quarter
- **THEN** they see the share of merged pull requests by work type and the two derived ratios

#### Scenario: A viewer drills into a work type

- **WHEN** a viewer selects the bug fix segment
- **THEN** they see the pull requests classified as bug fixes in that period

#### Scenario: Classification is disabled

- **WHEN** a workspace has classification disabled
- **THEN** the work mix surface states that classification is off and how to enable it
- **AND** every other surface is unaffected

### Requirement: Merged throughput is presentable per pull request

The system SHALL present merged pull requests as a cumulative series over the selected period, in
which each merged pull request is a distinct point that raises the running total by exactly one.
The series SHALL be positioned by the time each pull request merged, so that the horizontal
distance between two points reflects the time between the merges rather than their ordinal
positions.

The final value of the series SHALL equal the merged pull request count the same surface reports
for the same scope and period, so that the finer presentation cannot disagree with the headline it
refines.

Each point SHALL identify the pull request it represents and SHALL lead to that pull request. The
series SHALL be available on the personal view scoped to the viewer's own merged pull requests, and
on the team view as one series per author over the same author selection the team view already
offers.

The series SHALL count merges only. No point SHALL be weighted by the size, latency, review depth,
or classification of the pull request it represents, on any surface.

#### Scenario: A contributor opens the cumulative chart

- **WHEN** a contributor opens their personal view for a period in which they merged pull requests
- **THEN** they see a line that rises by one at each of their merged pull requests
- **AND** the line's final value equals the merged pull request count stated for that period

#### Scenario: A viewer identifies an individual merge

- **WHEN** a viewer inspects one point of the cumulative series
- **THEN** the pull request that point represents is identified by number and title
- **AND** the viewer can reach that pull request from the chart

#### Scenario: Two merges happen far apart

- **WHEN** two consecutive merged pull requests are separated by a long interval, and two others by
  a short one
- **THEN** the horizontal distance between the first pair is greater than between the second

#### Scenario: A viewer opens the team view

- **WHEN** a viewer opens the team view with authors selected
- **THEN** they see one cumulative series per selected author, drawn over the same period
- **AND** the series are labelled by name and are not ordered by their totals

#### Scenario: A contributor merged nothing in the period

- **WHEN** a contributor merged no pull request in the selected period
- **THEN** the chart states that plainly without implying underperformance
- **AND** it does not draw a line at zero that could be read as a measured decline

#### Scenario: A weighted step is requested

- **WHEN** any client requests the cumulative series weighted by change size, cycle time, or any
  metric other than the count of merges
- **THEN** no such series is available from the system

#### Scenario: Part of the period precedes recorded coverage

- **WHEN** the selected period begins before the coverage the merged pull request data reaches
- **THEN** the chart marks the uncovered span and names it, as the bucketed charts do
- **AND** the running total over that span is not presented as a measurement

### Requirement: Charts are readable without relying on color alone

The system SHALL make every chart's series distinguishable without depending on color alone, SHALL
expose the underlying values in text, and SHALL keep charts legible at the viewport widths the rest
of the product supports. The non-color distinction a chart's legend shows SHALL be the same
distinction the chart's marks carry, so that a legend entry identifies a mark rather than merely
naming a series.

Where a chart's points are individual events rather than period buckets, the values exposed as text
SHALL be one row per event, identifying the event, and the horizontal axis SHALL carry enough
labelled positions for a point to be located in time. Where more events fall in the period than the
chart can mark distinctly, the line SHALL still be drawn through every event and the text SHALL
still list every event.

#### Scenario: A viewer cannot distinguish colors

- **WHEN** a viewer reads a multi-series chart
- **THEN** each series is identifiable by label and by a non-color distinction

#### Scenario: A viewer matches a legend entry to a mark

- **WHEN** a viewer reads a chart's legend beside its marks
- **THEN** the swatch for each series carries the same non-color distinction as that series' marks
- **AND** a chart drawn with filled areas does not describe its series with line-style swatches

#### Scenario: A viewer needs exact values

- **WHEN** a viewer inspects a chart
- **THEN** the underlying per-bucket values are available as text

#### Scenario: A viewer needs the values behind an event chart

- **WHEN** a viewer inspects a chart whose points are individual events
- **THEN** the underlying values are available as text, one row per event, each row identifying its
  event and the running value at it

#### Scenario: A period holds more events than can be marked distinctly

- **WHEN** a chart's period contains more events than it can draw as separate marks
- **THEN** the line still passes through every event
- **AND** every event is still listed in the chart's text values

#### Scenario: A viewer opens a chart on a narrow viewport

- **WHEN** a chart is rendered on a narrow viewport
- **THEN** it remains legible without the page scrolling horizontally
