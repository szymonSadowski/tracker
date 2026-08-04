## ADDED Requirements

### Requirement: Installing on an additional account is reachable from the product

A GitHub App installation covers exactly one GitHub account, so repositories belonging to an
organization are only reachable through an installation on that organization. The system SHALL
offer a workspace owner an action that starts an installation on a different GitHub account, and
SHALL keep that action available from a workspace that already has an active installation.

#### Scenario: An owner of a personal-account workspace wants organization repositories

- **WHEN** a workspace owner whose installation targets a personal account opens the settings
  surface
- **THEN** an action to install the App on another GitHub account is offered
- **AND** it is distinct from the action that manages the existing installation's repositories

#### Scenario: The App slug is not configured

- **WHEN** the deployment has no GitHub App slug configured
- **THEN** the surface explains that an additional installation must be started from GitHub
- **AND** offers no action that would lead to a broken destination

### Requirement: The consequence of installing on another account is disclosed

An additional installation produces an additional workspace rather than extending the current one.
The system SHALL state this before the operator leaves for GitHub, so that the resulting workspace
is not read as a failure to add repositories.

#### Scenario: An owner follows the install action

- **WHEN** a workspace owner is presented with the action to install on another account
- **THEN** the surface states that installing on another account creates a separate workspace
- **AND** states that it does not add repositories to the current workspace

#### Scenario: An organization is absent from GitHub's install picker

- **WHEN** a workspace owner is presented with the action to install on another account
- **THEN** the surface names the conditions under which an organization does not appear as an
  install target: the App being restricted to a single account, and the operator lacking
  organization owner rights

### Requirement: An organization installation yields an organization workspace

The system SHALL record an installation whose account is an organization against a workspace bound
to that organization, separate from any workspace bound to the installing user's personal account.

#### Scenario: An owner installs on an organization while holding a personal workspace

- **WHEN** an operator who already owns a workspace for their personal account completes an
  installation on an organization
- **THEN** a second workspace bound to the organization is recorded
- **AND** the operator holds owner rights on it
- **AND** the personal workspace's repository scope is unchanged
