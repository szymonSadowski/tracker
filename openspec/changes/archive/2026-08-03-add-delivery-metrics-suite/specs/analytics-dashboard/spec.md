## MODIFIED Requirements

### Requirement: The team view presents aggregates, not individual rankings

The system SHALL present team metrics as aggregates over the team's pull requests for a selected
period, and SHALL NOT present a ranking of team members by any throughput or latency metric. The
team view SHALL present those aggregates both as current-period values and as a trend over the
period buckets, so a viewer sees direction and not only level.

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

## ADDED Requirements

### Requirement: Every rollup metric is available as a time series chart

The system SHALL render each aggregate metric as a chart over the selected period at a granularity
the viewer controls, and SHALL let the viewer switch between day, week, and month granularity
without changing the period.

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
as shares of the whole and as absolute line counts.

#### Scenario: A viewer opens the churn chart

- **WHEN** a viewer opens the churn chart for a repository over 6 months
- **THEN** each bucket shows new code, refactor, and rework as shares summing to the whole

#### Scenario: A viewer switches to absolute values

- **WHEN** a viewer switches the churn chart from shares to line counts
- **THEN** each bucket shows the three categories as absolute line counts

#### Scenario: Rework rises sharply in a bucket

- **WHEN** a bucket's rework share exceeds the needs-focus benchmark threshold
- **THEN** the bucket is marked against that threshold on the chart

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
published industry data rather than a target the workspace set.

#### Scenario: A viewer reads a benchmarked metric

- **WHEN** a viewer opens a metric with configured benchmarks
- **THEN** they see its tier, the threshold boundaries, and the source of the benchmark

#### Scenario: A metric has no benchmark

- **WHEN** a metric has no configured benchmark
- **THEN** no tier is shown and none is implied

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

### Requirement: Charts are readable without relying on color alone

The system SHALL make every chart's series distinguishable without depending on color alone, SHALL
expose the underlying values in text, and SHALL keep charts legible at the viewport widths the rest
of the product supports.

#### Scenario: A viewer cannot distinguish colors

- **WHEN** a viewer reads a multi-series chart
- **THEN** each series is identifiable by label and by a non-color distinction

#### Scenario: A viewer needs exact values

- **WHEN** a viewer inspects a chart
- **THEN** the underlying per-bucket values are available as text

#### Scenario: A viewer opens a chart on a narrow viewport

- **WHEN** a chart is rendered on a narrow viewport
- **THEN** it remains legible without the page scrolling horizontally
