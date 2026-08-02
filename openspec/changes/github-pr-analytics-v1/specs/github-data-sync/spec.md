## Purpose

Brings pull request, review, and commit data from GitHub into the product — a historical backfill
when a repository comes into scope, and a recurring incremental sync thereafter — such that
repeating any sync is safe and the resulting data is complete and observable.

## ADDED Requirements

### Requirement: Backfill populates history when a repository enters scope

The system SHALL perform a historical backfill for each repository when it enters a workspace's
scope, covering a bounded window ending at the present.

#### Scenario: Repository enters scope

- **WHEN** a repository is added to an installation's selection
- **THEN** the system ingests pull requests updated within the backfill window, together with
  their reviews, commits, and diff statistics
- **AND** the workspace's surfaces reflect that data without further operator action

#### Scenario: Backfill is interrupted

- **WHEN** a backfill fails or is interrupted partway through a repository
- **THEN** the system resumes from the last recorded progress point rather than restarting
- **AND** no duplicate records are created

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
exceeding it.

#### Scenario: Quota approaches exhaustion during backfill

- **WHEN** remaining quota for an installation falls below a safety threshold
- **THEN** the system pauses non-urgent sync work and resumes after the quota resets
- **AND** records progress so no work is repeated

#### Scenario: GitHub returns a rate limit or server error

- **WHEN** a GitHub request fails with a rate limit or transient server error
- **THEN** the system retries with backoff, honoring any retry-after signal
- **AND** the operation fails permanently only after retries are exhausted

### Requirement: Sync state is observable

The system SHALL record, per repository, the outcome and time of sync operations, and SHALL expose
whether a repository's history is still being backfilled.

#### Scenario: A member views a workspace during backfill

- **WHEN** a member opens a workspace surface while backfill is in progress
- **THEN** the surface indicates that data is incomplete and which repositories are still loading

#### Scenario: Sync has been failing

- **WHEN** a repository's syncs have failed repeatedly
- **THEN** the failure and its reason are visible to workspace owners

### Requirement: Members can trigger a sync on demand

The system SHALL provide a way to request an immediate incremental sync for a workspace, subject
to rate limiting.

#### Scenario: Member requests sync immediately after merging

- **WHEN** a member triggers an on-demand sync
- **THEN** an incremental sync is enqueued
- **AND** repeated requests within a short interval do not enqueue redundant work
