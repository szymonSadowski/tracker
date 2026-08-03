-- The phase, churn, and quality metrics land on the existing analysis row, never a second one
-- (design.md D5/D1). Every column is nullable: absent is never zero (spec: pr-metrics).

ALTER TABLE pr_analysis
  -- Cycle time decomposed. Sums to cycle_time_seconds whenever all three are computable.
  ADD COLUMN coding_time_seconds  integer,
  ADD COLUMN pickup_time_seconds  integer,
  ADD COLUMN review_time_seconds  integer,

  -- Churn, in lines. Absent — not zero — for an unmerged pull request, one with no ingested file
  -- data, and one whose file list GitHub truncated.
  ADD COLUMN new_code_lines  integer,
  ADD COLUMN refactor_lines  integer,
  ADD COLUMN rework_lines    integer,
  -- Lines dropped by the workspace's churn exclusion patterns, and therefore absent from the
  -- three categories and from the total they share.
  ADD COLUMN excluded_lines  integer,
  -- True when the rework figure leaned on the file-level recency approximation rather than only
  -- on the exact post-review component (design.md D2). Surfaced, not hidden.
  ADD COLUMN churn_used_recency_estimate boolean,

  ADD COLUMN review_depth integer,
  -- Share in [0,1] of the changed lines present at ready-for-review that survived unaltered.
  ADD COLUMN pr_maturity  double precision,

  -- Which inputs were present, so a definition change can target only the rows it affects
  -- (spec: pr-metrics "Metric definitions declare their revision and their inputs").
  ADD COLUMN has_first_commit_input boolean NOT NULL DEFAULT false,
  ADD COLUMN has_human_review_input boolean NOT NULL DEFAULT false,
  ADD COLUMN has_file_data_input    boolean NOT NULL DEFAULT false,
  ADD COLUMN has_commit_file_input  boolean NOT NULL DEFAULT false,
  ADD COLUMN has_comment_data_input boolean NOT NULL DEFAULT false,

  -- The full definition identity: the code revision plus the workspace configuration that
  -- participates in it (rework window, exclusion patterns). Distinct from computed_version so a
  -- configuration change is detectable without bumping the shared code revision.
  ADD COLUMN definition_revision text;

-- Targeting a churn-only recompute without scanning rows that never had churn inputs.
CREATE INDEX pr_analysis_churn_inputs_idx ON pr_analysis (workspace_id, definition_revision)
  WHERE has_file_data_input = true;
