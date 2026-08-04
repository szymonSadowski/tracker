## Purpose

Gives the product a consistent identity and a predictable frame around every surface: what the
operator sees in the topbar and the browser tab, how they tell which workspace they are looking at,
and how a control paired with a button is aligned.

## ADDED Requirements

### Requirement: The product identifies itself in its chrome

The topbar SHALL present the product's own wordmark, not a value derived from the workspace. The
wordmark SHALL remain the link to the workspace root.

#### Scenario: A member opens any workspace surface

- **WHEN** a signed-in member opens a workspace surface
- **THEN** the topbar presents the product wordmark
- **AND** activating it navigates to the workspace root

#### Scenario: Two workspaces are opened in turn

- **WHEN** a member opens a workspace bound to a personal account and then one bound to an
  organization
- **THEN** the wordmark is identical on both
- **AND** it does not take on either account's name

### Requirement: The workspace in view is named in the chrome

Because a member may hold more than one workspace and the surfaces themselves carry no account
name, the chrome SHALL name the workspace currently in view, presented as secondary to the
wordmark rather than competing with it.

#### Scenario: A member holding two workspaces switches between them

- **WHEN** a member switches from one workspace to another
- **THEN** the chrome names the workspace now in view
- **AND** the name shown changes to match

#### Scenario: A member reads the chrome at a glance

- **WHEN** the wordmark and the workspace name are shown together
- **THEN** the workspace name is visually subordinate to the wordmark

### Requirement: The product is identifiable in the browser tab

The system SHALL supply an icon for the browser tab, so an open tab is identifiable among others
without reading its title.

#### Scenario: A surface is opened in a browser tab

- **WHEN** any surface of the product is loaded
- **THEN** the browser tab shows the product's icon
- **AND** the icon is derived from the same mark as the wordmark

### Requirement: A button paired with a control aligns with it

When a button sits on the same row as an input, a select, or a radio group, the system SHALL align
them on a shared centre line. A button SHALL NOT carry spacing that displaces it from a row it
participates in.

#### Scenario: A button follows a text input on one row

- **WHEN** a surface presents a text input and a submit button on the same row
- **THEN** their centres align
- **AND** neither is displaced vertically relative to the other

#### Scenario: A button follows a select on one row

- **WHEN** a surface presents a select and a save button on the same row
- **THEN** their centres align

#### Scenario: A button stands alone beneath a block of text

- **WHEN** a button is presented on its own beneath explanatory text rather than in a row
- **THEN** it is separated from that text by deliberate spacing
- **AND** that spacing does not come from a rule that also applies to buttons inside rows
