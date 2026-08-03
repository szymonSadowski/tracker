## Purpose

Answers what a change was *for* — classifying each pull request into a kind of work using a language
model, and deriving the mix-of-work ratios from it — without ever letting a probabilistic judgment
alter a metric that is supposed to be deterministic.

## ADDED Requirements

### Requirement: Every pull request is classified into exactly one work type

The system SHALL classify each ingested pull request into exactly one of a fixed set of work types:
feature, bug fix, refactor, chore, documentation, test, or dependency update. The set SHALL be
closed — a classification outside it SHALL be rejected and treated as a classification failure.

#### Scenario: A pull request is classified

- **WHEN** a pull request is submitted for classification
- **THEN** it receives exactly one work type from the fixed set
- **AND** the classification is stored on the pull request's existing analysis record

#### Scenario: The model returns an unrecognized type

- **WHEN** the model returns a work type outside the fixed set
- **THEN** the result is discarded and the pull request is left unclassified
- **AND** the failure is recorded for observability

### Requirement: Classification uses only stored pull request content

The system SHALL classify from data already stored — title, description, commit messages, changed
file paths, and diff statistics. Classification SHALL NOT require a call to GitHub, and SHALL NOT
transmit source code file contents.

#### Scenario: A pull request is classified after ingestion

- **WHEN** classification runs for a stored pull request
- **THEN** no GitHub API request is made
- **AND** the payload sent to the provider contains no file contents

#### Scenario: A pull request has an empty description

- **WHEN** a pull request has no description
- **THEN** classification proceeds from its title, commits, and changed paths

### Requirement: Classification carries a confidence and a rationale

The system SHALL store, with each classification, a confidence value and a short rationale, and
SHALL treat a classification below the configured confidence threshold as unclassified for the
purpose of derived ratios.

#### Scenario: A confident classification is produced

- **WHEN** a pull request is classified above the confidence threshold
- **THEN** the type, confidence, and rationale are stored
- **AND** the pull request contributes to derived ratios

#### Scenario: A low-confidence classification is produced

- **WHEN** a classification falls below the confidence threshold
- **THEN** it is stored and visible on the pull request
- **AND** it is excluded from every derived ratio

### Requirement: Classification is versioned and content-addressed

The system SHALL record which prompt and model revision produced each classification, and SHALL NOT
re-classify a pull request whose classification inputs are unchanged and whose revision is current.

#### Scenario: A pull request is unchanged since classification

- **WHEN** classification runs again over a pull request whose title, description, commits, and
  changed paths are unchanged at the current revision
- **THEN** no provider call is made and the existing classification is retained

#### Scenario: A pull request's description is edited

- **WHEN** a pull request's description changes after classification
- **THEN** the pull request becomes eligible for re-classification

#### Scenario: The prompt revision changes

- **WHEN** the prompt or model revision is updated and a bulk re-run is triggered
- **THEN** classifications at the older revision are recomputed
- **AND** each result records the new revision

### Requirement: Classification failures degrade to absence, never to a default

The system SHALL represent a pull request that could not be classified as unclassified. The system
SHALL NOT assign a fallback work type, and SHALL NOT count an unclassified pull request as any type.

#### Scenario: The provider is unavailable

- **WHEN** the classification provider is unreachable or returns an error after retries
- **THEN** the affected pull requests remain unclassified
- **AND** the pull requests are eligible for classification on a later run

#### Scenario: An unclassified pull request reaches a surface

- **WHEN** an unclassified pull request appears in a list
- **THEN** its work type is shown as unavailable rather than as a default type

### Requirement: Classification never alters a deterministic metric

The system SHALL keep every metric defined as deterministic independent of classification. Enabling,
disabling, re-running, or failing classification SHALL NOT change any latency, throughput, churn, or
size metric.

#### Scenario: Classification is disabled for a workspace

- **WHEN** a workspace has classification turned off
- **THEN** all latency, throughput, churn, and size metrics are computed and displayed normally
- **AND** only the classification-derived ratios are unavailable

#### Scenario: A pull request is re-classified

- **WHEN** a pull request's work type changes on re-classification
- **THEN** its cycle time, churn, and size metrics are unchanged

### Requirement: Mix-of-work ratios are derived from classifications

The system SHALL derive, per period bucket and scope, a defect ratio — the share of classified
merged pull requests that are bug fixes — and an innovation ratio — the share that are features.
Both SHALL be computed over classified pull requests only, and SHALL report how many pull requests
in the bucket were unclassified.

#### Scenario: A ratio is computed for a period

- **WHEN** 100 merged pull requests in a period are classified and 15 are bug fixes
- **THEN** the defect ratio for that period is 15%

#### Scenario: Part of a period is unclassified

- **WHEN** 40 of 100 merged pull requests in a period are unclassified
- **THEN** the ratios are computed over the 60 classified pull requests
- **AND** the bucket reports 40 unclassified

#### Scenario: A period has no classified pull requests

- **WHEN** no pull request in a bucket is classified
- **THEN** the ratios for that bucket are absent rather than zero

### Requirement: Classification work is bounded and observable

The system SHALL bound classification throughput and spend per workspace, SHALL run it at lower
priority than ingestion, and SHALL expose how many pull requests are classified, pending, and
failed.

#### Scenario: A large backlog is classified

- **WHEN** a workspace has a large backlog of unclassified pull requests
- **THEN** classification proceeds within the configured rate and spend bounds
- **AND** ingestion and aggregation are not delayed by it

#### Scenario: A spend bound is reached

- **WHEN** a workspace reaches its configured classification spend bound for a period
- **THEN** classification pauses rather than failing
- **AND** the pause and its reason are visible to workspace owners

#### Scenario: An owner inspects classification state

- **WHEN** a workspace owner views classification state
- **THEN** they see the classified, pending, and failed counts and the current revision

### Requirement: A classification can be corrected by a workspace owner

The system SHALL let a workspace owner override a pull request's work type, SHALL mark the
classification as human-corrected, and SHALL NOT overwrite a correction on a later automatic run.

#### Scenario: An owner corrects a classification

- **WHEN** a workspace owner sets a pull request's work type
- **THEN** the pull request carries the corrected type, marked as human-corrected
- **AND** the derived ratios recompute using the corrected type

#### Scenario: A corrected pull request is re-run

- **WHEN** a bulk re-classification runs over a human-corrected pull request
- **THEN** the correction is preserved

#### Scenario: A non-owner attempts a correction

- **WHEN** a workspace member who is not an owner attempts to override a work type
- **THEN** the request is rejected
