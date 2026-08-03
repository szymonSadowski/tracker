## Purpose

Repository visibility already mirrors GitHub, and permission decisions are already cached with a
bounded lifetime. What the capability does not yet say is what resolving those decisions is allowed
to cost — which is how a correct, clearly-written check became the dominant cost of every page once
the database moved a network away.

## MODIFIED Requirements

### Requirement: Permission decisions are cached with a bounded lifetime

The system SHALL cache repository permission decisions for a bounded period to avoid a GitHub
request per access check, and SHALL invalidate the cache when an installation changes.

Resolving access for a workspace SHALL cost a number of database round trips that does not grow
with the number of repositories in that workspace, whether the decisions are cached, absent, or
expired. Where decisions must be resolved against GitHub, those requests SHALL be issued
concurrently under a bound rather than one after another.

#### Scenario: A user loads several pages in quick succession

- **WHEN** a user makes repeated requests within the cache lifetime
- **THEN** permission is resolved from cache without additional GitHub requests

#### Scenario: Repository selection changes

- **WHEN** an installation's repository selection is modified
- **THEN** cached permission decisions for that workspace are invalidated

#### Scenario: A workspace gains more repositories

- **WHEN** access is resolved for a workspace with many in-scope repositories, all decisions cached
- **THEN** the number of database round trips is the same as for a workspace with one repository

#### Scenario: Every cached decision has expired

- **WHEN** access is resolved and no decision for the workspace is still within its lifetime
- **THEN** the decisions are re-resolved and written back without a round trip per repository
- **AND** the resulting visible repository set is identical to the set resolved one repository at a
  time

#### Scenario: A user may read only some of a workspace's repositories

- **WHEN** access is resolved for a user permitted to read some in-scope repositories and not others
- **THEN** exactly the permitted repositories are visible
- **AND** batching the resolution never makes a repository visible that an individual check would
  have refused
