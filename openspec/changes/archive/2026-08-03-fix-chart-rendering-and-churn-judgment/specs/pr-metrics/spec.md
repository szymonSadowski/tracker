## MODIFIED Requirements

### Requirement: Code churn classifies changed lines by kind

The system SHALL classify the lines changed by each merged pull request into new code, refactored
code, and rework, and SHALL record each as a line count and as a share of the pull request's total
changed lines. The three shares SHALL sum to the whole, and SHALL do so exactly at the precision
they are reported in, so that a consumer may rely on the sum without re-deriving it from the line
counts.

- **new code** — lines added to a file where no prior line was replaced
- **refactor** — lines that modify or delete code older than the rework recency window
- **rework** — lines that modify or delete code written within the rework recency window, and lines
  changed after the pull request's first review

#### Scenario: A pull request adds a new file

- **WHEN** a merged pull request adds a file of 200 lines and changes nothing else
- **THEN** new code is 200 lines and 100%, and refactor and rework are zero

#### Scenario: The three shares do not divide evenly

- **WHEN** a bucket's line counts produce shares that cannot each be represented exactly at the
  reported precision, such as an equal three-way split
- **THEN** the three reported shares still sum to exactly the whole
- **AND** no reported share exceeds the whole
