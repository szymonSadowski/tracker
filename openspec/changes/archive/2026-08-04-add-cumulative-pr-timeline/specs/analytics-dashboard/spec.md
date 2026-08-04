## ADDED Requirements

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

## MODIFIED Requirements

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
