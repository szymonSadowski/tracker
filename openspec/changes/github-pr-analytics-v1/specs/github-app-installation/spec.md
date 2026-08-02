## Purpose

Connects a customer's GitHub account to the product by installing a GitHub App against a selected
set of repositories, and keeps that connection — its credentials, its repository selection, and its
lifecycle — accurate over time.

## ADDED Requirements

### Requirement: Install the App against selected repositories

The system SHALL support installing the GitHub App on a GitHub account (organization or user) with
a **selected-repositories** grant. The system SHALL NOT require an all-repositories grant.

#### Scenario: Operator installs with a subset of repositories

- **WHEN** a user completes the GitHub App installation flow having selected 3 of an
  organization's 40 repositories
- **THEN** the system records the installation, the account it targets, and exactly those 3
  repositories as in scope
- **AND** no data is ingested from the other 37 repositories

#### Scenario: Installation targets an account that already has an installation

- **WHEN** an installation callback arrives for a GitHub account that already has an active
  installation recorded
- **THEN** the system updates the existing installation rather than creating a duplicate

### Requirement: Installation creates exactly one workspace

The system SHALL create one workspace per installation, and SHALL associate every subsequently
ingested record with that workspace.

#### Scenario: First installation for an account

- **WHEN** an installation is recorded for a GitHub account with no existing workspace
- **THEN** the system creates a workspace bound to that installation
- **AND** the installing user becomes a member of that workspace with owner rights

### Requirement: Installation credentials are obtained and refreshed automatically

The system SHALL obtain short-lived installation access tokens and SHALL refresh them before
expiry without operator action. The system SHALL NOT persist an installation access token beyond
its validity.

#### Scenario: Token expires during a long backfill

- **WHEN** an installation access token expires while a sync operation is in progress
- **THEN** the system obtains a fresh token and continues the operation
- **AND** the operation does not fail or lose progress

#### Scenario: Credentials are rejected by GitHub

- **WHEN** GitHub rejects the App's credentials for an installation
- **THEN** the system marks the installation as needing attention
- **AND** surfaces a reconnect action to workspace owners
- **AND** stops scheduling further sync work for that installation

### Requirement: Repository selection changes are honored

The system SHALL detect changes to an installation's repository selection and SHALL adjust its
scope accordingly.

#### Scenario: A repository is added to the selection

- **WHEN** a repository is added to an existing installation's selection
- **THEN** the system records the repository as in scope
- **AND** enqueues a backfill for that repository

#### Scenario: A repository is removed from the selection

- **WHEN** a repository is removed from an existing installation's selection
- **THEN** the system stops syncing that repository
- **AND** excludes its pull requests from all aggregates
- **AND** retains previously ingested data for that repository unless the workspace is deleted

### Requirement: Repositories are identified by immutable GitHub identifiers

The system SHALL key repositories by their GitHub node identifier, not by owner/name, so that
renames and transfers do not create duplicates or orphan data.

#### Scenario: A tracked repository is renamed on GitHub

- **WHEN** a repository in scope is renamed
- **THEN** the system updates the stored name on the existing repository record
- **AND** all previously ingested pull requests remain associated with it

### Requirement: Discover contributors from in-scope repositories

The system SHALL determine which GitHub accounts are relevant to a workspace from authorship and
review activity within its in-scope repositories, and SHALL classify each account as a human or a
bot using GitHub's account type.

#### Scenario: A bot opens pull requests

- **WHEN** ingestion encounters pull requests authored by a GitHub account typed as a bot
- **THEN** the account is recorded and marked as a bot
- **AND** it is excluded from workspace aggregates by default

### Requirement: Uninstall stops all processing

The system SHALL detect uninstallation and SHALL immediately cease all sync and analysis work for
that installation.

#### Scenario: The App is uninstalled from GitHub

- **WHEN** an installation is removed on GitHub
- **THEN** the system marks the installation inactive
- **AND** cancels or drains any pending sync and analysis work for it
- **AND** discards its stored credentials
- **AND** the workspace's existing data remains readable to its members until they delete the
  workspace
