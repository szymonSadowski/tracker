## Purpose

Establishes who someone is and what they may see, using GitHub as the single source of both — sign
-in is GitHub OAuth, and visibility of a repository's data follows that repository's permissions on
GitHub rather than a separate permission model.

## ADDED Requirements

### Requirement: GitHub OAuth is the only sign-in method

The system SHALL authenticate users exclusively through GitHub OAuth, and SHALL identify each user
by their GitHub account identifier.

#### Scenario: A user signs in

- **WHEN** a user completes the GitHub OAuth flow
- **THEN** the system establishes a session identified by their GitHub account identifier
- **AND** their profile details are populated from GitHub

#### Scenario: A user changes their GitHub username

- **WHEN** a user renames their GitHub account and signs in again
- **THEN** the system recognizes them as the same user
- **AND** their historical pull request data remains attributed to them

#### Scenario: The user declines authorization

- **WHEN** a user cancels or is denied the OAuth flow
- **THEN** no session is created and no user record is written

### Requirement: The signed-in user is linked to their contributor record

The system SHALL associate a signed-in user with the contributor record for the same GitHub
account, without any manual mapping step.

#### Scenario: A contributor signs in for the first time

- **WHEN** a user whose GitHub account already appears as a pull request author signs in
- **THEN** their personal view shows their own pull requests immediately

### Requirement: Repository visibility mirrors GitHub

The system SHALL permit a user to view data derived from a repository only if that user has read
access to that repository on GitHub.

#### Scenario: A member without repository access opens a workspace

- **WHEN** a workspace member who cannot read repository R on GitHub views the workspace
- **THEN** pull requests from repository R are excluded from what they see
- **AND** aggregates presented to them exclude repository R

#### Scenario: A user's repository access is revoked

- **WHEN** a user's read access to a repository is revoked on GitHub
- **THEN** the system stops showing them that repository's data within the permission cache lifetime
- **AND** immediately if the installation's repository selection changed

### Requirement: Permission decisions are cached with a bounded lifetime

The system SHALL cache repository permission decisions for a bounded period to avoid a GitHub
request per access check, and SHALL invalidate the cache when an installation changes.

#### Scenario: A user loads several pages in quick succession

- **WHEN** a user makes repeated requests within the cache lifetime
- **THEN** permission is resolved from cache without additional GitHub requests

#### Scenario: Repository selection changes

- **WHEN** an installation's repository selection is modified
- **THEN** cached permission decisions for that workspace are invalidated

### Requirement: Workspace rights govern configuration

The system SHALL restrict installation management, repository selection, team management, and
workspace deletion to workspace owners. All members may read data they are permitted to see.

#### Scenario: A member attempts to change teams

- **WHEN** a workspace member who is not an owner attempts to create or modify a team
- **THEN** the action is rejected

#### Scenario: An owner manages the installation

- **WHEN** a workspace owner opens installation settings
- **THEN** they can change repository selection and disconnect the installation

### Requirement: Sessions expire and can be revoked

The system SHALL expire sessions after a bounded period of inactivity and SHALL allow a user to
sign out, invalidating the session.

#### Scenario: A user signs out

- **WHEN** a user signs out
- **THEN** the session no longer grants access to any workspace data

### Requirement: Access checks are enforced server-side

The system SHALL enforce every access check on the server, and SHALL NOT rely on the client
omitting data the user may not see.

#### Scenario: A client requests data directly

- **WHEN** a request is made for a workspace or repository the user may not access, bypassing the
  user interface
- **THEN** the request is rejected without disclosing whether the resource exists
