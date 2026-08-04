## MODIFIED Requirements

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

## ADDED Requirements

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
