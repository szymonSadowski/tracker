## Purpose

Keeps each customer's data isolated within its own workspace, and lets a workspace organize the
contributors discovered from its repositories into teams that reflect how the organization actually
works.

## ADDED Requirements

### Requirement: Every record belongs to exactly one workspace

The system SHALL associate every stored record with exactly one workspace, and SHALL scope every
read to a single workspace.

#### Scenario: A query is issued without workspace scope

- **WHEN** any data access is attempted without a workspace scope
- **THEN** the access is rejected rather than returning data across workspaces

#### Scenario: Two workspaces track the same repository

- **WHEN** two separate installations each include a repository with the same GitHub identifier
- **THEN** each workspace stores and reads its own records for it
- **AND** neither workspace's members can observe the other's data

### Requirement: Workspace membership is explicit

The system SHALL maintain an explicit set of members for each workspace, each with either owner or
member rights, and SHALL treat a person who is not a member as having no access.

#### Scenario: A GitHub user outside the workspace signs in

- **WHEN** an authenticated user who is not a member of any workspace signs in
- **THEN** they see no workspace data
- **AND** are offered the option to install the App and create a workspace

#### Scenario: An owner grants access

- **WHEN** a workspace owner adds a GitHub account as a member
- **THEN** that account gains member access to the workspace on next sign-in

### Requirement: Contributors are derived from activity, not org membership

The system SHALL treat the workspace's contributor roster as the set of accounts that authored or
reviewed a pull request in an in-scope repository within the retained history.

#### Scenario: An organization member never touches an in-scope repository

- **WHEN** a GitHub organization has 200 members but only 23 have authored or reviewed pull
  requests in the selected repositories
- **THEN** the workspace roster contains those 23 contributors

#### Scenario: A new contributor appears

- **WHEN** an account not previously seen authors a pull request in an in-scope repository
- **THEN** that account is added to the roster on ingestion
- **AND** appears as unassigned to any team

### Requirement: Teams are defined within the product

The system SHALL allow workspace owners to create, rename, and delete teams, and SHALL NOT derive
team structure from GitHub teams.

#### Scenario: An owner creates a team

- **WHEN** a workspace owner creates a team named "Platform"
- **THEN** the team exists in the workspace and can have contributors assigned to it

#### Scenario: A team is deleted

- **WHEN** a team with assigned members is deleted
- **THEN** the team is removed
- **AND** its contributors return to unassigned
- **AND** no pull request or metric data is deleted

### Requirement: Contributors are assigned to teams

The system SHALL allow assigning each contributor to at most one team, and SHALL allow changing or
removing that assignment.

#### Scenario: A contributor moves between teams

- **WHEN** a contributor assigned to team A is reassigned to team B
- **THEN** subsequent team aggregates count their pull requests under team B

### Requirement: Unassigned contributors are visible, not hidden

The system SHALL surface contributors who are not assigned to any team, so that team aggregates
are never silently incomplete.

#### Scenario: New contributors accumulate unassigned

- **WHEN** a workspace has contributors with activity but no team assignment
- **THEN** their count is shown to workspace owners with an action to assign them

#### Scenario: Team totals exclude unassigned work

- **WHEN** a team view is displayed and unassigned contributors have activity in the period
- **THEN** the view indicates that unassigned activity exists and is not included in team totals

### Requirement: Bots are excluded from the roster by default

The system SHALL keep bot accounts out of the contributor roster and out of team assignment,
while retaining their data.

#### Scenario: A bot is discovered during ingestion

- **WHEN** ingestion encounters a bot-authored pull request
- **THEN** the bot does not appear in the roster or in team assignment
- **AND** its pull requests remain queryable when bot inclusion is explicitly requested
