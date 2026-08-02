## Purpose

Turns normalized pull request data into a derived per-pull-request record of throughput and latency
metrics — the layer every read surface reads from — with definitions precise enough to be trusted
and recomputable when they change.

## Requirements

### Requirement: Every pull request has one analysis record

The system SHALL produce exactly one analysis record per pull request, and SHALL keep it current
as the underlying pull request changes.

#### Scenario: A pull request is ingested

- **WHEN** a pull request is ingested or updated
- **THEN** its analysis record is created or recomputed
- **AND** the record identifies which revision of the metric definitions produced it

#### Scenario: A pull request is updated after analysis

- **WHEN** a previously analyzed pull request receives a new review or is merged
- **THEN** its analysis record is recomputed to reflect the new state

### Requirement: Metrics are computed deterministically from stored data

The system SHALL compute all metrics in this capability as a pure function of stored pull request,
review, and commit data. Computing a metric SHALL NOT require a call to an external service.

#### Scenario: Identical inputs are analyzed twice

- **WHEN** the same stored data is analyzed twice with the same definition revision
- **THEN** the resulting metric values are identical

### Requirement: Latency metrics use explicit anchors

The system SHALL compute latency metrics between the following anchors:

- **cycle time** — from when the pull request became ready for review to when it merged
- **draft duration** — from creation to when it became ready for review
- **time to first review** — from ready-for-review to the first review submitted by another account
- **time to approval** — from ready-for-review to the first approving review
- **time to merge after approval** — from first approval to merge

#### Scenario: A pull request opened as a draft is merged

- **WHEN** a pull request is created as a draft, marked ready 2 hours later, and merged 6 hours
  after that
- **THEN** draft duration is 2 hours and cycle time is 6 hours

#### Scenario: A pull request never opened as a draft

- **WHEN** a pull request is created ready for review
- **THEN** draft duration is zero and cycle time is measured from creation

### Requirement: Unavailable metrics are absent, never zero

The system SHALL represent a metric that cannot be computed as absent. The system SHALL NOT
substitute zero or any other placeholder value.

#### Scenario: A pull request is merged with no review

- **WHEN** a pull request is merged without any review
- **THEN** time to first review, time to approval, and time to merge after approval are absent
- **AND** cycle time is still computed

#### Scenario: A pull request is still open

- **WHEN** a pull request has not merged
- **THEN** cycle time is absent
- **AND** metrics that do not depend on merge are computed

### Requirement: Volume metrics describe change size

The system SHALL compute, per pull request, lines added, lines deleted, files changed, and a size
classification derived from them.

#### Scenario: A large refactor is ingested

- **WHEN** a pull request changing 40 files with 2,000 added and 1,800 deleted lines is analyzed
- **THEN** those counts are recorded and the pull request is classified into the largest size band

### Requirement: Review effort metrics describe iteration, not blame

The system SHALL compute the number of review rounds and the number of pushes occurring after the
first review, as measures of iteration on the change.

#### Scenario: A pull request goes through revisions

- **WHEN** a pull request receives a review, is pushed to twice, and is reviewed again before
  merging
- **THEN** review rounds is 2 and post-review pushes is 2

#### Scenario: Branch history is rewritten

- **WHEN** a pull request's branch is force-pushed so earlier commit identifiers no longer exist
- **THEN** review effort metrics remain computable from review and push events
- **AND** the analysis record is not left in an error state

### Requirement: Bot activity is excluded from metrics by default

The system SHALL exclude pull requests authored by bot accounts, and reviews submitted by bot
accounts, from aggregate metrics unless bot inclusion is explicitly requested.

#### Scenario: A dependency bot opens many pull requests

- **WHEN** a bot account opens 50 dependency-update pull requests in a period
- **THEN** workspace and team aggregates for that period exclude them by default

#### Scenario: Bot review does not count as human review

- **WHEN** a pull request's only review is submitted by a bot
- **THEN** time to first review is absent

### Requirement: Analysis is recomputable in bulk

The system SHALL support recomputing analysis records for a workspace, repository, or time range
without re-fetching data from GitHub.

#### Scenario: A metric definition changes

- **WHEN** metric definitions are revised and recomputation is triggered
- **THEN** affected analysis records are recomputed from stored data
- **AND** each recomputed record carries the new definition revision

### Requirement: The analysis record accommodates future producers

The analysis record SHALL be extensible with fields produced by later analysis of the same pull
request, without requiring a separate record or invalidating existing values.

#### Scenario: A later capability annotates a pull request

- **WHEN** an additional analysis produces descriptive fields for an already-analyzed pull request
- **THEN** those fields are stored on the existing analysis record
- **AND** the deterministic metrics on that record are unchanged
