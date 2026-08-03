## MODIFIED Requirements

### Requirement: Latency metrics use explicit anchors

The system SHALL compute latency metrics between the following anchors:

- **cycle time** — from the first commit on the pull request's branch to when it merged
- **coding time** — from the first commit to when the pull request became ready for review
- **pickup time** — from ready-for-review to the first review submitted by another human account
- **review time** — from the first review by another human account to merge
- **draft duration** — from creation to when it became ready for review
- **time to first review** — from ready-for-review to the first review submitted by another account
- **time to approval** — from ready-for-review to the first approving review
- **time to merge after approval** — from first approval to merge

Cycle time SHALL equal the sum of coding time, pickup time, and review time whenever all three are
computable, so that a decomposition presented to a viewer always accounts for the whole. When the
first commit is not known, cycle time SHALL be measured from the point the pull request became ready
for review, and coding time SHALL be absent.

#### Scenario: A pull request opened as a draft is merged

- **WHEN** a pull request is created as a draft, marked ready 2 hours later, and merged 6 hours
  after that
- **THEN** draft duration is 2 hours and the ready-to-merge span is 6 hours

#### Scenario: A pull request never opened as a draft

- **WHEN** a pull request is created ready for review
- **THEN** draft duration is zero and cycle time is measured from its first commit

#### Scenario: Cycle time decomposes into its phases

- **WHEN** a pull request's first commit is 10 hours before it is marked ready, its first review
  arrives 2 hours after that, and it merges 4 hours later
- **THEN** coding time is 10 hours, pickup time is 2 hours, review time is 4 hours, and cycle time
  is 16 hours

#### Scenario: A commit lands after the pull request is opened

- **WHEN** a pull request's first commit is recorded after it became ready for review
- **THEN** coding time is zero rather than negative
- **AND** cycle time is measured from the earlier of the first commit and ready-for-review

#### Scenario: Commit history is unavailable

- **WHEN** a pull request has no known first commit
- **THEN** coding time is absent
- **AND** cycle time is measured from ready-for-review

#### Scenario: A pull request merges with no review

- **WHEN** a pull request is merged without any review by another human account
- **THEN** pickup time and review time are absent
- **AND** cycle time is still computed

### Requirement: Unavailable metrics are absent, never zero

The system SHALL represent a metric that cannot be computed as absent. The system SHALL NOT
substitute zero or any other placeholder value. This SHALL hold for metrics that depend on data a
pull request may lack entirely, including per-file diff data and review comments, as well as for
metrics that depend on events that did not occur.

#### Scenario: A pull request is merged with no review

- **WHEN** a pull request is merged without any review
- **THEN** time to first review, time to approval, and time to merge after approval are absent
- **AND** cycle time is still computed

#### Scenario: A pull request is still open

- **WHEN** a pull request has not merged
- **THEN** cycle time is absent
- **AND** metrics that do not depend on merge are computed

#### Scenario: A pull request has no ingested file data

- **WHEN** a pull request was ingested before per-file diff data was collected, or its file data
  could not be retrieved
- **THEN** its churn metrics are absent
- **AND** its latency and size metrics are computed normally

#### Scenario: A pull request has no review comments recorded

- **WHEN** review comment data is unavailable for a pull request
- **THEN** review depth is absent rather than zero
- **AND** a pull request whose reviews genuinely carried no comments has a review depth of zero

## ADDED Requirements

### Requirement: Code churn classifies changed lines by kind

The system SHALL classify the lines changed by each merged pull request into new code, refactored
code, and rework, and SHALL record each as a line count and as a share of the pull request's total
changed lines. The three shares SHALL sum to the whole.

- **new code** — lines added to a file where no prior line was replaced
- **refactor** — lines that modify or delete code older than the rework recency window
- **rework** — lines that modify or delete code written within the rework recency window, and lines
  changed after the pull request's first review

#### Scenario: A pull request adds a new file

- **WHEN** a merged pull request adds a file of 200 lines and changes nothing else
- **THEN** new code is 200 lines and 100%, and refactor and rework are zero

#### Scenario: A pull request modifies long-standing code

- **WHEN** a merged pull request replaces 50 lines last written a year ago
- **THEN** those 50 lines are classified as refactor

#### Scenario: A pull request modifies recently written code

- **WHEN** a merged pull request replaces 30 lines written inside the rework recency window
- **THEN** those 30 lines are classified as rework

#### Scenario: A pull request is changed after review

- **WHEN** 40 lines are changed in commits pushed after the pull request's first review
- **THEN** those 40 lines are classified as rework regardless of the age of the code they touch

#### Scenario: A pull request is not merged

- **WHEN** a pull request is open or closed without merging
- **THEN** its churn metrics are absent

#### Scenario: A path is excluded from churn

- **WHEN** a pull request changes files matching the workspace's churn exclusion patterns, such as
  generated code or lock files
- **THEN** those lines are excluded from all three churn categories and from the total
- **AND** the pull request records how many lines were excluded

### Requirement: Review depth measures review conversation, not approval

The system SHALL compute, per pull request, the number of review comments submitted by human
accounts other than the author, counting comments on the diff and comments attached to review
submissions, and excluding comments authored by the pull request author or by bots.

#### Scenario: A pull request receives review comments

- **WHEN** two reviewers leave 5 and 3 comments respectively and the author replies 4 times
- **THEN** review depth is 8

#### Scenario: A bot comments on a pull request

- **WHEN** a bot posts comments on a pull request
- **THEN** those comments do not count toward review depth

#### Scenario: A pull request is approved without comment

- **WHEN** a pull request receives an approving review carrying no comments
- **THEN** review depth is zero

### Requirement: PR maturity measures how much of a change survived submission

The system SHALL compute, per merged pull request, the share of its changed lines that were present
at the point it became ready for review and were not subsequently altered.

#### Scenario: A pull request is merged as submitted

- **WHEN** a pull request is merged with no changes after it became ready for review
- **THEN** its PR maturity is 100%

#### Scenario: A pull request is substantially revised after submission

- **WHEN** a pull request of 200 changed lines has 50 of them altered after becoming ready for review
- **THEN** its PR maturity is 75%

#### Scenario: A pull request's branch is rewritten

- **WHEN** a pull request's branch is force-pushed so that earlier commits no longer exist
- **THEN** PR maturity is computed from the recorded push events and diff snapshots
- **AND** the analysis record is not left in an error state

### Requirement: Metric definitions declare their revision and their inputs

The system SHALL record, per analysis record, which metric definition revision produced it and
whether each metric's required inputs were present, so that a bulk recompute can target only the
records a change actually affects.

#### Scenario: A churn-only definition change is released

- **WHEN** the churn definition is revised while latency definitions are unchanged
- **THEN** recomputation can be targeted at records carrying churn values
- **AND** records without churn inputs are not needlessly reprocessed

#### Scenario: File data arrives for a previously ingested pull request

- **WHEN** per-file diff data is backfilled for a pull request analyzed without it
- **THEN** that pull request's analysis record is recomputed and gains churn metrics
