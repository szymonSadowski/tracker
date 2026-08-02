## Purpose

Presents the derived pull request metrics to the people they describe — a team view of aggregate
throughput and latency, a personal view of one's own work, and a pull request list underneath both
— while being honest about incomplete data and refusing to rank individuals against each other.

## Requirements

### Requirement: The team view presents aggregates, not individual rankings

The system SHALL present team metrics as aggregates over the team's pull requests for a selected
period, and SHALL NOT present a ranking of team members by any throughput or latency metric.

#### Scenario: A member opens the team view

- **WHEN** a member opens a team view for the last 30 days
- **THEN** they see the team's merged pull request count, median cycle time, median time to first
  review, and change size distribution for that period

#### Scenario: Per-person ordering is requested

- **WHEN** any client requests team members ordered by cycle time, throughput, or a comparable
  productivity metric
- **THEN** no such ordering is available from the system

### Requirement: The personal view shows one's own work

The system SHALL provide each user a view of their own pull requests and metrics over a selected
period, including a trend across periods.

#### Scenario: A user opens their personal view

- **WHEN** a signed-in contributor opens their personal view
- **THEN** they see their own merged pull request count, their cycle time, and how those compare
  to their own previous period

#### Scenario: A user has no activity in the period

- **WHEN** a contributor has no pull requests in the selected period
- **THEN** the view states that plainly without implying underperformance

### Requirement: Viewing another person's detail requires being a workspace owner

The system SHALL restrict per-contributor detail views to workspace owners and to the contributor
themselves.

#### Scenario: A member opens a colleague's detail

- **WHEN** a workspace member who is not an owner requests another contributor's detail view
- **THEN** the request is rejected

### Requirement: Time period is an explicit control

The system SHALL let the viewer choose the time period for every metric surface, and SHALL state
the active period on the surface.

#### Scenario: A viewer changes the period

- **WHEN** a viewer switches from 30 days to 7 days
- **THEN** all metrics on the surface recompute for the new period
- **AND** the displayed period label reflects the change

### Requirement: The pull request list is filterable and links out to GitHub

The system SHALL present the underlying pull requests for any metric surface, filterable by
repository, author, team, and state, with each entry linking to the pull request on GitHub.

#### Scenario: A viewer drills into a metric

- **WHEN** a viewer opens the pull request list from a team metric
- **THEN** the list contains exactly the pull requests that metric was computed from

#### Scenario: A viewer opens a pull request

- **WHEN** a viewer selects a pull request entry
- **THEN** they are taken to that pull request on GitHub

### Requirement: Absent metrics are shown as absent

The system SHALL display a metric that could not be computed as unavailable, and SHALL NOT render
it as zero.

#### Scenario: A pull request was merged without review

- **WHEN** a pull request with no review appears in a list
- **THEN** its time to first review is shown as unavailable rather than as zero

#### Scenario: An aggregate has partial coverage

- **WHEN** an aggregate is computed over a set where some pull requests lack the underlying metric
- **THEN** the surface indicates how many pull requests the aggregate covers

### Requirement: Data completeness is visible

The system SHALL indicate when the data behind a surface is incomplete or stale, and SHALL show
when the workspace last synced.

#### Scenario: Backfill is still running

- **WHEN** a viewer opens a surface while a repository's backfill is in progress
- **THEN** the surface states that historical data is still loading and which repositories are
  affected

#### Scenario: Sync has been failing

- **WHEN** the workspace's most recent syncs have failed
- **THEN** the surface shows that data may be stale and when it last synced successfully

### Requirement: Cold start states name the missing prerequisite

The system SHALL, when a surface has no data, state the specific reason and offer the action that
resolves it.

#### Scenario: No repositories are selected

- **WHEN** a workspace has an installation but no repositories in scope
- **THEN** the surface says so and links to repository selection

#### Scenario: No teams exist yet

- **WHEN** a workspace has contributors but no teams
- **THEN** the team surface says so and offers to create a team
