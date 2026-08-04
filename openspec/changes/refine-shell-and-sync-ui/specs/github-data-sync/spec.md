## ADDED Requirements

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
