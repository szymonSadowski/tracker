-- Derived layer: one row per pull request (design.md D5, spec: pr-metrics).
-- Durations are stored in seconds and are NULL — never zero — where uncomputable (D6).

CREATE TABLE pr_analysis (
  workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  pull_request_id uuid NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,
  repository_id   uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,

  -- computed by this change -------------------------------------------------------------
  cycle_time_seconds              integer,
  draft_duration_seconds          integer,
  time_to_first_review_seconds    integer,
  time_to_approval_seconds        integer,
  time_to_merge_after_approval_seconds integer,
  review_cycles                   integer,
  post_review_pushes              integer,
  additions                       integer,
  deletions                       integer,
  files_changed                   integer,
  size_bucket                     text CHECK (size_bucket IN ('xs', 's', 'm', 'l', 'xl')),

  -- denormalized for aggregate queries; kept in step by the analysis job
  author_contributor_id uuid REFERENCES contributors (id) ON DELETE SET NULL,
  author_is_bot         boolean NOT NULL DEFAULT false,
  merged_at             timestamptz,
  opened_at             timestamptz,
  ready_for_review_at   timestamptz,
  pr_state              text,

  -- reserved for the later LLM layer: added to this row, never a second row (D5)
  summary                text,
  pr_type                text,
  risk_flags             jsonb,
  analysis_skill_version text,

  computed_at      timestamptz NOT NULL DEFAULT now(),
  computed_version integer NOT NULL,

  PRIMARY KEY (workspace_id, pull_request_id)
);

CREATE INDEX pr_analysis_merged_idx ON pr_analysis (workspace_id, merged_at)
  WHERE author_is_bot = false;
CREATE INDEX pr_analysis_author_idx ON pr_analysis (workspace_id, author_contributor_id, merged_at);
CREATE INDEX pr_analysis_repo_idx ON pr_analysis (workspace_id, repository_id, merged_at);
CREATE INDEX pr_analysis_version_idx ON pr_analysis (workspace_id, computed_version);
