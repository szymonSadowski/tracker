## ADDED Requirements

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

## MODIFIED Requirements

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
