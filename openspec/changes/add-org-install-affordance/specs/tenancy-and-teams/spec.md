## ADDED Requirements

### Requirement: Creating an additional workspace stays reachable

The system SHALL keep the surface that creates a workspace reachable to a signed-in user
regardless of how many workspaces they already hold. A user holding exactly one workspace SHALL NOT
be routed past it.

#### Scenario: A user holding one workspace opens the workspace list

- **WHEN** a signed-in user who is a member of exactly one workspace opens the workspace list
- **THEN** the list is rendered
- **AND** it offers the action that creates another workspace

#### Scenario: A user holding no workspace signs in

- **WHEN** a signed-in user who is a member of no workspace opens the workspace list
- **THEN** the action that creates a workspace is offered, as it is today

#### Scenario: A user follows a workspace link directly

- **WHEN** a signed-in user opens a workspace they are a member of
- **THEN** they reach that workspace's surfaces without passing through the workspace list
