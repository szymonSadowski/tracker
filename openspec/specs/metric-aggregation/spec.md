## Purpose

Turns the per-pull-request analysis records into period-bucketed aggregates — the single layer every
chart, tile, and export reads from — with normalization, percentiles, and benchmark tiers defined
once so that two surfaces showing the same metric can never disagree.

## Requirements

### Requirement: Metrics are aggregated into explicit period buckets

The system SHALL aggregate metrics into fixed period buckets of day, week, and month, and SHALL
assign each pull request to a bucket by a single anchor timestamp per metric. Bucket boundaries
SHALL be evaluated in the workspace's configured time zone.

#### Scenario: A metric is requested as a series

- **WHEN** a surface requests a metric over a range at weekly granularity
- **THEN** it receives one value per week in the range, including weeks with no activity
- **AND** each value states which bucket boundaries produced it

#### Scenario: A week has no pull requests

- **WHEN** a bucket inside covered history contains no qualifying pull requests
- **THEN** the bucket is present in the series with a count of zero and absent latency metrics

#### Scenario: A pull request merges near a bucket boundary

- **WHEN** a pull request merges at a time that falls in different buckets under different time zones
- **THEN** it is assigned to the bucket determined by the workspace time zone
- **AND** the same assignment is produced on every recomputation

### Requirement: Aggregates are available at four scopes

The system SHALL compute every aggregate metric at workspace, team, repository, and contributor
scope, and SHALL apply the same definition at each scope.

#### Scenario: The same metric is read at two scopes

- **WHEN** a metric is read for a team and for the workspace containing it over the same period
- **THEN** both values are produced by the same definition applied to different pull request sets

#### Scenario: A pull request belongs to two teams

- **WHEN** a pull request's author is a member of two teams during the period
- **THEN** the pull request contributes to both teams' aggregates
- **AND** the workspace aggregate counts it once

### Requirement: Latency metrics are aggregated as percentiles and mean

The system SHALL expose p50, p75, and p90 alongside the arithmetic mean for every latency metric,
and SHALL state how many pull requests each aggregate was computed from.

#### Scenario: A latency metric is aggregated

- **WHEN** cycle time is aggregated for a period
- **THEN** p50, p75, p90, mean, and the contributing pull request count are all available

#### Scenario: Too few pull requests to aggregate

- **WHEN** a bucket contains fewer pull requests than the minimum sample size
- **THEN** the percentile values are absent rather than computed from the small sample
- **AND** the contributing count is still reported

### Requirement: PR throughput is normalized per active contributor

The system SHALL compute PR throughput as merged pull requests in a bucket divided by the number of
active contributors in that bucket and scope. A contributor SHALL count as active for a bucket only
if they authored at least one pull request within the workspace's coverage and are not marked as a
bot or a non-contributor.

An absent rate SHALL NOT suppress a merged count that exists. Where a bucket has merged pull
requests recorded and no contributor in its denominator, the two are inconsistent: the system SHALL
report the merged count for that bucket, and SHALL make the inconsistency inspectable rather than
presenting the bucket as one in which nothing is known. Absence of a denominator describes what is
known about tenure, and SHALL never be presented as absence of output.

#### Scenario: Throughput is computed for a team

- **WHEN** a team of 5 active contributors merges 20 pull requests in a week
- **THEN** the team's weekly PR throughput is 4 pull requests per contributor

#### Scenario: A bot merges pull requests

- **WHEN** a bot account merges pull requests in the bucket
- **THEN** those pull requests are excluded from the numerator
- **AND** the bot is not counted in the denominator

#### Scenario: A scope has no active contributors

- **WHEN** a bucket has no active contributors in scope and no merged pull requests
- **THEN** throughput is absent rather than zero or undefined

#### Scenario: A bucket has merges but no denominator

- **WHEN** a bucket has merged pull requests recorded and no contributor in its denominator, because
  the merges precede the earliest membership interval on record
- **THEN** the bucket's merged count is reported rather than withheld
- **AND** the bucket is not presented as one in which nothing was merged or nothing is known

#### Scenario: The two are compared over a period

- **WHEN** a period's buckets are summed and compared with the merged pull request count reported
  for the same scope and period
- **THEN** the two agree, whatever the membership intervals on record

### Requirement: The contributor denominator is prorated over partial membership

The system SHALL prorate a contributor's contribution to the denominator by the fraction of the
bucket during which they were a member of the scope, so that joins, departures, and team moves do
not distort throughput.

#### Scenario: A contributor moves teams mid-month

- **WHEN** a contributor is a member of team A for the first half of a month and team B for the
  second half
- **THEN** they count as 0.5 contributors in each team's monthly denominator
- **AND** their pull requests are attributed to the team they belonged to on the merge date

#### Scenario: A contributor joins mid-period

- **WHEN** a contributor joins the workspace halfway through a month
- **THEN** they count as 0.5 contributors in that month's denominator
- **AND** as a full contributor in subsequent months

#### Scenario: A contributor leaves

- **WHEN** a contributor is removed from the workspace
- **THEN** their historical pull requests remain in past buckets' numerators
- **AND** they are not counted in denominators for buckets after their departure

### Requirement: Merged pull requests are available as an event series

The system SHALL provide merged pull requests for a scope and period as an ordered series of merge
events rather than only as bucket totals. Each event SHALL carry the instant the pull request
merged, the pull request's identity sufficient to name it and to link to it, and the author it is
attributed to.

Events SHALL be ordered by merge time. The count of events for a scope and period SHALL equal the
merged pull request count the bucketed aggregate reports for the same scope and period, so that the
two resolutions of the same metric cannot disagree.

Where the series covers more than one contributor, events SHALL be grouped by contributor in the
same name order the per-contributor bucketed series uses, and the grouping SHALL NOT be ordered by
the number of events a contributor has. A contributor with no merged pull request in the period
SHALL be absent from the series rather than present with an empty group.

The series SHALL report the coverage it rests on, as the bucketed aggregates do, so a period
reaching before recorded coverage is distinguishable from a period in which nothing merged.

#### Scenario: A merge event series is requested

- **WHEN** a client requests merged pull requests for a contributor and period
- **THEN** it receives one event per merged pull request, in merge-time order
- **AND** each event names its pull request and the instant it merged

#### Scenario: The two resolutions are compared

- **WHEN** the merge event series and the bucketed merged count are computed for the same scope and
  period
- **THEN** the number of events equals the sum of the bucket counts

#### Scenario: A multi-contributor series is requested

- **WHEN** a client requests merge events for several contributors over one period
- **THEN** the contributors are grouped in name order
- **AND** the grouping does not reflect how many events each contributor has

#### Scenario: A contributor merged nothing in the period

- **WHEN** a contributor merged no pull request in the requested period
- **THEN** that contributor is absent from the series

#### Scenario: The period reaches before coverage

- **WHEN** the requested period begins before the coverage the underlying data reaches
- **THEN** the series reports the point from which its events are complete

### Requirement: Comparable metrics carry a benchmark tier

The system SHALL assign a benchmark tier — elite, good, fair, or needs focus — to each metric for
which published thresholds are configured, SHALL evaluate the tier against the metric's p75
aggregate, and SHALL expose the thresholds alongside the tier.

#### Scenario: A metric is compared to benchmarks

- **WHEN** a workspace's p75 cycle time is read for a period
- **THEN** the response includes the assigned tier and the threshold boundaries that produced it

#### Scenario: A metric has no configured benchmark

- **WHEN** a metric has no published thresholds configured
- **THEN** no tier is assigned and no tier is inferred

#### Scenario: The benchmark thresholds are revised

- **WHEN** benchmark thresholds are updated
- **THEN** tiers are re-evaluated from existing aggregates without recomputing the aggregates

### Requirement: Aggregates are derived only from analysis records

The system SHALL compute every aggregate as a pure function of stored per-pull-request analysis
records and workspace membership history. Computing an aggregate SHALL NOT call an external service.

#### Scenario: The same period is aggregated twice

- **WHEN** the same underlying records are aggregated twice at the same definition revision
- **THEN** the resulting values are identical

#### Scenario: The LLM provider is unavailable

- **WHEN** the classification provider is unreachable
- **THEN** every aggregate not derived from classification is computed normally

### Requirement: Aggregates are invalidated when their inputs change

The system SHALL recompute the aggregates covering a pull request whenever that pull request's
analysis record changes, and SHALL recompute the aggregates for a scope whenever membership history
affecting that scope changes.

#### Scenario: A pull request is re-analyzed

- **WHEN** an analysis record is recomputed and its cycle time changes
- **THEN** the aggregates for every bucket and scope containing that pull request are recomputed

#### Scenario: Team membership is corrected retroactively

- **WHEN** a contributor's team membership dates are corrected
- **THEN** the affected teams' aggregates are recomputed for the affected buckets

#### Scenario: A definition revision changes

- **WHEN** the aggregation definitions are revised and recomputation is triggered
- **THEN** affected aggregates are rebuilt from stored analysis records without calling GitHub
- **AND** each rebuilt aggregate carries the new definition revision

### Requirement: Aggregates report their coverage

The system SHALL record, for every aggregate, how many pull requests contributed to it and how many
were excluded for lacking the underlying metric, so a surface can distinguish a low value from a
thinly covered one.

#### Scenario: Some pull requests lack the metric

- **WHEN** an aggregate is computed over 40 pull requests of which 12 lack churn data
- **THEN** the aggregate reports 28 contributing and 12 excluded

#### Scenario: A bucket precedes the workspace's coverage start

- **WHEN** a requested bucket begins earlier than the workspace's recorded coverage
- **THEN** the bucket is marked as outside coverage rather than reported as empty

### Requirement: Aggregates never rank individuals against each other

The system SHALL NOT expose an ordering of contributors by any throughput, latency, churn, or
classification-derived metric, at any scope.

#### Scenario: A ranked contributor list is requested

- **WHEN** any client requests contributors ordered by a metric
- **THEN** no such ordering is available from the system

#### Scenario: A contributor reads their own aggregate

- **WHEN** a contributor requests their own contributor-scope aggregates
- **THEN** the values are returned without reference to any other contributor's values
