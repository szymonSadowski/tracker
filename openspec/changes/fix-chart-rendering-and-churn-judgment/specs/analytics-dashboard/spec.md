## MODIFIED Requirements

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

### Requirement: Charts are readable without relying on color alone

The system SHALL make every chart's series distinguishable without depending on color alone, SHALL
expose the underlying values in text, and SHALL keep charts legible at the viewport widths the rest
of the product supports. The non-color distinction a chart's legend shows SHALL be the same
distinction the chart's marks carry, so that a legend entry identifies a mark rather than merely
naming a series.

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

#### Scenario: A viewer opens a chart on a narrow viewport

- **WHEN** a chart is rendered on a narrow viewport
- **THEN** it remains legible without the page scrolling horizontally

### Requirement: The personal view shows one's own work

The system SHALL provide each user a view of their own pull requests and metrics over a selected
period, including a trend across periods. The personal view SHALL NOT present a benchmark tier, a
benchmark threshold, or any other comparison against an industry or team norm for the viewer's own
metrics; its only comparison SHALL be against the viewer's own previous period. It SHALL present
the same descriptive and coverage information as the team view, including drill-through to the
pull requests behind a bucket, the coverage a metric's data reaches, and the same presentation
toggles.

#### Scenario: A user opens their personal view

- **WHEN** a signed-in contributor opens their personal view
- **THEN** they see their own merged pull request count, their cycle time, and how those compare
  to their own previous period

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
