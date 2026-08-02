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
from an absence of coverage.

#### Scenario: A surface queries a period outside coverage

- **WHEN** a period is requested that begins earlier than a repository's recorded coverage start
- **THEN** the system reports that the period is only partially covered, and from when

#### Scenario: Coverage extends after a history sync

- **WHEN** a history sync completes for a repository
- **THEN** the recorded coverage start moves to the earliest point now ingested

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
so that a record's content does not depend on which path ingested it.

#### Scenario: The same pull request arrives via both paths

- **WHEN** a pull request is ingested by backfill and later re-ingested by incremental sync
- **THEN** the resulting normalized record is identical apart from fields whose underlying GitHub
  state genuinely changed

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
