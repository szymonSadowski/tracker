## MODIFIED Requirements

### Requirement: All ingestion paths produce identical normalized records

The system SHALL normalize data from every ingestion path into the same internal representation,
so that a record's content does not depend on which path ingested it. This SHALL hold for pull
requests, reviews, commits, review comments, per-file diff statistics, and default-branch commits
alike.

#### Scenario: The same pull request arrives via both paths

- **WHEN** a pull request is ingested by backfill and later re-ingested by incremental sync
- **THEN** the resulting normalized record is identical apart from fields whose underlying GitHub
  state genuinely changed

#### Scenario: File data arrives via a different path than the pull request

- **WHEN** a pull request's per-file diff statistics are ingested by a later pass than the one that
  ingested the pull request itself
- **THEN** the normalized file records are identical to those the original path would have produced
- **AND** the pull request record is not duplicated or otherwise altered

#### Scenario: A commit is reachable both through a pull request and the default branch

- **WHEN** the same commit is ingested as part of a pull request and as a default-branch commit
- **THEN** it resolves to one normalized commit record, associated with both

### Requirement: A repository records how far back its coverage extends

The system SHALL record, per repository, the earliest point from which its pull request data is
known to be complete, and SHALL expose that point so surfaces can distinguish an absence of data
from an absence of coverage. Coverage SHALL be recorded separately for each class of data whose
ingestion can lag — at minimum pull requests, per-file diff statistics, and default-branch commits —
so that a metric requiring file-level data is not presented as covered merely because the pull
requests are.

#### Scenario: A surface queries a period outside coverage

- **WHEN** a period is requested that begins earlier than a repository's recorded coverage start
- **THEN** the system reports that the period is only partially covered, and from when

#### Scenario: Coverage extends after a history sync

- **WHEN** a history sync completes for a repository
- **THEN** the recorded coverage start moves to the earliest point now ingested

#### Scenario: Pull requests are covered but file data is not

- **WHEN** a period is fully covered for pull requests but only partly covered for per-file diff
  statistics
- **THEN** latency metrics for that period report full coverage
- **AND** churn metrics for that period report partial coverage, and from when

## ADDED Requirements

### Requirement: Per-file diff statistics are ingested for each pull request

The system SHALL ingest, for every pull request in scope, the set of files it changed with each
file's path, additions, deletions, and change kind (added, modified, removed, renamed). This data
SHALL be keyed such that re-ingesting it produces no duplicates, and SHALL be retained so churn can
be recomputed without calling GitHub again.

#### Scenario: A pull request is ingested

- **WHEN** a pull request enters the system through any ingestion path
- **THEN** its changed files are ingested with per-file additions, deletions, and change kind

#### Scenario: A pull request changes more files than one response returns

- **WHEN** a pull request changes more files than a single API response can return
- **THEN** the system pages until the file list is complete
- **AND** records the file list as complete only once it is

#### Scenario: A pull request exceeds the file limit GitHub will return

- **WHEN** a pull request changes more files than GitHub will enumerate
- **THEN** the files returned are ingested and the pull request is marked as having a truncated file
  list
- **AND** metrics that require a complete file list are absent for it rather than computed from part

#### Scenario: The same file list is ingested twice

- **WHEN** an identical file list is ingested a second time
- **THEN** no additional rows are created and no stored values change

### Requirement: Review comments are ingested with their authorship

The system SHALL ingest review comments on pull requests — both comments attached to review
submissions and comments left on the diff — recording the author, the time, and which pull request
and review they belong to.

#### Scenario: A reviewer comments on a diff

- **WHEN** a reviewer leaves comments on lines of a pull request's diff
- **THEN** each comment is ingested with its author and timestamp

#### Scenario: A comment is edited or deleted on GitHub

- **WHEN** a previously ingested comment is deleted on GitHub
- **THEN** the next sync reflects its removal rather than retaining a phantom comment

### Requirement: Default-branch commits are ingested independently of pull requests

The system SHALL ingest commits on each in-scope repository's default branch, with author, commit
time, and line statistics, whether or not those commits are associated with an ingested pull
request, so that commit activity is a complete series rather than a by-product of pull request
ingestion.

#### Scenario: Commit activity is requested for a repository

- **WHEN** a commit activity series is requested for a repository
- **THEN** it reflects every default-branch commit in the covered range

#### Scenario: A commit lands without a pull request

- **WHEN** a commit is pushed directly to the default branch
- **THEN** it appears in commit activity
- **AND** it does not create a pull request record

#### Scenario: The default branch is rewritten

- **WHEN** a repository's default branch history is rewritten so previously ingested commits are no
  longer reachable
- **THEN** the affected commits are marked unreachable rather than deleted
- **AND** they are excluded from commit activity going forward

### Requirement: File-level data is backfilled progressively for already-ingested history

The system SHALL fill in per-file diff statistics and review comments for pull requests ingested
before those were collected, as a resumable pass that is lower priority than incremental sync and
that respects the existing quota rules.

#### Scenario: The capability is first enabled for an existing workspace

- **WHEN** file-level ingestion becomes available for a workspace with existing pull request history
- **THEN** a backfill pass begins filling in file data for already-ingested pull requests
- **AND** surfaces report churn coverage as partial while it runs

#### Scenario: The fill-in pass competes with incremental sync

- **WHEN** a file-level fill-in pass is running and an incremental sync becomes due
- **THEN** the incremental sync is serviced first

#### Scenario: The fill-in pass is interrupted

- **WHEN** the pass fails, is paused for rate limits, or is interrupted partway
- **THEN** it resumes from the last recorded position rather than restarting
- **AND** the coverage already achieved remains recorded
