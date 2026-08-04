## Purpose

Brings pull request, review, and commit data from GitHub into the product — a historical backfill
when a repository comes into scope, and a recurring incremental sync thereafter — such that
repeating any sync is safe and the resulting data is complete and observable.

## Requirements

### Requirement: Backfill populates history when a repository enters scope

The system SHALL perform a historical backfill for each repository when it enters a workspace's
scope, covering a default window ending at the present. The default window SHALL be a starting
point rather than a ceiling: a member-requested history sync SHALL be able to extend coverage
earlier than it.

#### Scenario: Repository enters scope

- **WHEN** a repository is added to an installation's selection
- **THEN** the system ingests pull requests updated within the default backfill window, together
  with their reviews, commits, and diff statistics
- **AND** the workspace's surfaces reflect that data without further operator action

#### Scenario: Backfill is interrupted

- **WHEN** a backfill fails or is interrupted partway through a repository
- **THEN** the system resumes from the last recorded progress point rather than restarting
- **AND** no duplicate records are created

#### Scenario: History is requested beyond the default window

- **WHEN** a member requests history earlier than the default backfill window
- **THEN** the system ingests that earlier history
- **AND** the default window does not prevent or truncate the request

### Requirement: Members can request a history sync over a chosen range

The system SHALL let a workspace member request ingestion of pull request history for the
workspace's in-scope repositories over a range they choose, either the repository's full history or
a range starting at a specified date. The request SHALL be accepted while other sync work is in
flight, and SHALL report per repository whether history for the requested range is already present.

#### Scenario: Member requests full history

- **WHEN** a member requests a history sync covering all available history
- **THEN** the system ingests pull requests older than the currently covered range, back to each
  repository's earliest pull request
- **AND** the workspace's surfaces reflect that data as it arrives, without waiting for every
  repository to finish

#### Scenario: Member requests a specific start date

- **WHEN** a member requests a history sync starting at a given date
- **THEN** the system ingests pull requests back to that date and no further
- **AND** a subsequent request for an earlier date extends coverage rather than starting over

#### Scenario: Requested range is already covered

- **WHEN** a member requests a range that is already fully ingested for a repository
- **THEN** no ingestion work is performed for that repository
- **AND** the member is told the range was already covered rather than being shown a failure

#### Scenario: History sync is requested while one is running

- **WHEN** a member requests a history sync for a workspace that already has one in progress
- **THEN** no duplicate work is enqueued
- **AND** the member is shown the progress of the request already running

### Requirement: Deepening extends coverage without refetching what is present

The system SHALL extend an already-backfilled repository's coverage backwards without re-ingesting
pull requests it already holds, and SHALL treat a partially completed deepening pass as resumable.

#### Scenario: Repository backfilled under a bounded window is deepened

- **WHEN** a history sync requests a range extending earlier than a repository's existing coverage
- **THEN** the system ingests only the pull requests older than the existing coverage
- **AND** the already-ingested pull requests are neither refetched nor duplicated

#### Scenario: Deepening is interrupted

- **WHEN** a deepening pass fails, is paused for rate limits, or is interrupted partway
- **THEN** the system resumes from the last recorded position rather than restarting the range
- **AND** the coverage already achieved before the interruption remains recorded

#### Scenario: Repository has no history older than its coverage

- **WHEN** a deepening pass reaches a repository's earliest pull request before reaching the
  requested start date
- **THEN** the repository is recorded as fully covered
- **AND** later requests for an earlier range perform no further work

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

### Requirement: Incremental sync keeps data current

The system SHALL run a recurring incremental sync for each in-scope repository that ingests pull
requests changed since the previous successful sync.

#### Scenario: A pull request is merged between syncs

- **WHEN** a pull request is merged and the next incremental sync runs
- **THEN** the stored pull request reflects the merged state and merge time

#### Scenario: Sync windows overlap

- **WHEN** an incremental sync covers a period already covered by a previous sync
- **THEN** re-ingesting those records produces no duplicates and no changed values

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

### Requirement: Writes are idempotent on GitHub identifiers

The system SHALL key every ingested entity by its GitHub node identifier scoped to its workspace,
and SHALL upsert rather than insert.

#### Scenario: The same payload is processed twice

- **WHEN** an identical payload is processed a second time
- **THEN** no additional rows are created and no stored values change

### Requirement: Raw payloads are retained for reprocessing

The system SHALL retain the payloads it receives from GitHub in a form that allows normalized and
derived data to be rebuilt without calling the GitHub API again.

#### Scenario: Normalization logic is corrected

- **WHEN** a defect in normalization is fixed and reprocessing is triggered
- **THEN** normalized records are rebuilt from retained payloads
- **AND** no GitHub API requests are required to do so

### Requirement: Rate limits are respected and never exhausted silently

The system SHALL track its remaining GitHub API quota and SHALL throttle or defer work rather than
exceeding it. History sync work SHALL be treated as lower priority than incremental sync, so that
keeping current data fresh is never starved by ingesting old data.

#### Scenario: Quota approaches exhaustion during backfill

- **WHEN** remaining quota for an installation falls below a safety threshold
- **THEN** the system pauses non-urgent sync work and resumes after the quota resets
- **AND** records progress so no work is repeated

#### Scenario: GitHub returns a rate limit or server error

- **WHEN** a GitHub request fails with a rate limit or transient server error
- **THEN** the system retries with backoff, honoring any retry-after signal
- **AND** the operation fails permanently only after retries are exhausted

#### Scenario: History sync competes with incremental sync for quota

- **WHEN** a history sync is running and an incremental sync becomes due
- **THEN** the incremental sync is serviced first
- **AND** the history sync continues with the remaining quota

### Requirement: Sync state is observable

The system SHALL record, per repository, the outcome and time of sync operations, and SHALL expose
whether a repository's history is still being backfilled.

#### Scenario: A member views a workspace during backfill

- **WHEN** a member opens a workspace surface while backfill is in progress
- **THEN** the surface indicates that data is incomplete and which repositories are still loading

#### Scenario: Sync has been failing

- **WHEN** a repository's syncs have failed repeatedly
- **THEN** the failure and its reason are visible to workspace owners

### Requirement: History sync progress is observable

The system SHALL expose, per repository, the state of an outstanding history sync — the range
requested, how far back ingestion has reached, and whether it is running, paused, complete, or
failed — and SHALL surface the reason when it fails.

#### Scenario: Member views the workspace during a history sync

- **WHEN** a member opens a workspace surface while a history sync is running
- **THEN** the surface shows which repositories are still ingesting history and how far back each
  has reached

#### Scenario: History sync pauses for rate limits

- **WHEN** a history sync is paused because API quota fell below the safety threshold
- **THEN** the surface states that it is paused for rate limits rather than showing it as failed
- **AND** it resumes without member action once quota permits

### Requirement: Members can trigger a sync on demand

The system SHALL provide a way to request an immediate incremental sync, subject to rate limiting,
and SHALL tell the requester the outcome of their request — whether work was enqueued, or the
request fell inside the rate limiting interval. A request SHALL be able to cover the whole
workspace or a single repository, and the rate limiting interval SHALL be measured against
requests covering the same target.

#### Scenario: Member requests sync immediately after merging

- **WHEN** a member triggers an on-demand sync
- **THEN** an incremental sync is enqueued
- **AND** repeated requests within a short interval do not enqueue redundant work

#### Scenario: Member triggers a sync inside the rate limiting interval

- **WHEN** a member triggers an on-demand sync less than the rate limiting interval after a
  previous one
- **THEN** the member is told the request was already covered by a recent sync
- **AND** the request is not silently discarded

#### Scenario: Member triggers a sync during backfill

- **WHEN** a member triggers an on-demand sync while repositories are still backfilling
- **THEN** repositories that have completed backfill are synced
- **AND** the member is told which repositories were skipped because their history is still loading

#### Scenario: Member syncs a single repository

- **WHEN** a member triggers a sync while looking at one repository
- **THEN** only that repository is synced
- **AND** a workspace-wide sync moments earlier does not cause the request to be treated as
  redundant

#### Scenario: Member requests a sync for a repository they cannot see

- **WHEN** a sync is requested for a repository the member cannot read on GitHub
- **THEN** the request is refused in the same terms as any other unreadable resource, without
  revealing whether the repository exists

### Requirement: The two sync requests are presented together and distinguished by direction

An on-demand sync and a history sync both fetch pull requests, and differ only in the direction
they move along the timeline: one brings the workspace up to date with what has changed since the
last sync, the other extends coverage backwards into history the workspace does not yet hold. The
system SHALL present both requests on one surface, and SHALL state for each which direction it
moves, so that neither is read as a duplicate of the other.

#### Scenario: An owner looks for a way to refresh the workspace

- **WHEN** a workspace owner opens the surface carrying the sync controls
- **THEN** both requests are presented together rather than in separate sections
- **AND** each states whether it fetches recent changes or older history

#### Scenario: An owner weighs the cost of each request

- **WHEN** both requests are presented
- **THEN** the surface distinguishes the one that completes promptly from the one that may run for
  hours and continues after the surface is closed

#### Scenario: An owner reads the control labels alone

- **WHEN** an owner reads only the two action labels, without the surrounding explanation
- **THEN** the labels differ in which direction in time they name
- **AND** neither label requires the other to be understood

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
