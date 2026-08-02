## MODIFIED Requirements

### Requirement: Time period is an explicit control

The system SHALL let the viewer choose the time period for every metric surface, and SHALL state
the active period on the surface. When the chosen period extends earlier than the workspace's
synced coverage, the surface SHALL say so rather than presenting the uncovered portion as though it
held no activity.

#### Scenario: A viewer changes the period

- **WHEN** a viewer switches from 30 days to 7 days
- **THEN** all metrics on the surface recompute for the new period
- **AND** the displayed period label reflects the change

#### Scenario: A viewer selects a period reaching before synced coverage

- **WHEN** a viewer chooses a period beginning earlier than the workspace's coverage start
- **THEN** the surface states that the period is only partially covered, and from when data exists
- **AND** the viewer is offered the history sync that would extend coverage

### Requirement: Data completeness is visible

The system SHALL indicate when the data behind a surface is incomplete or stale, and SHALL show
when the workspace last synced. Incompleteness SHALL distinguish data that is still arriving from
data that was never requested.

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
