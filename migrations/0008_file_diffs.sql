-- Per-file diff statistics (spec: github-data-sync, design.md D2/D5).
--
-- Churn is classified from these rows rather than from a whole-pull-request total, and they are
-- retained so churn can be recomputed at a new definition without calling GitHub again.

CREATE TABLE pr_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  pull_request_id uuid NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,
  path            text NOT NULL,
  additions       integer NOT NULL DEFAULT 0,
  deletions       integer NOT NULL DEFAULT 0,
  -- GitHub's changeType, lowercased. 'changed' is the REST fallback for a mode-only change.
  change_kind     text NOT NULL
                  CHECK (change_kind IN ('added', 'modified', 'removed', 'renamed', 'copied',
                                         'changed')),
  ingested_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX pr_files_path_idx ON pr_files (workspace_id, pull_request_id, path);
CREATE INDEX pr_files_pr_idx ON pr_files (workspace_id, pull_request_id);

-- The same statistics per commit. The post-review rework component is exact because it reads
-- these rows: lines touched by commits that landed after the first human review.
CREATE TABLE pr_commit_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  pull_request_id uuid NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,
  commit_node_id  text NOT NULL,
  commit_oid      text,
  path            text NOT NULL,
  additions       integer NOT NULL DEFAULT 0,
  deletions       integer NOT NULL DEFAULT 0,
  change_kind     text NOT NULL
                  CHECK (change_kind IN ('added', 'modified', 'removed', 'renamed', 'copied',
                                         'changed')),
  -- Denormalized from the commit so churn can bucket by "before or after first review" without
  -- a join, and so a force-push that drops the commit row leaves the statistics interpretable.
  committed_at    timestamptz NOT NULL
);

CREATE UNIQUE INDEX pr_commit_files_key_idx
  ON pr_commit_files (workspace_id, commit_node_id, path);
CREATE INDEX pr_commit_files_pr_idx
  ON pr_commit_files (workspace_id, pull_request_id, committed_at);

ALTER TABLE pull_requests
  -- True when GitHub stopped enumerating files before the list was complete. Metrics needing a
  -- complete list are absent for such a pull request rather than computed from part of it.
  ADD COLUMN files_truncated boolean NOT NULL DEFAULT false,
  -- When file data was last collected. Set even when the pull request changed no files, so the
  -- fill-in pass has a monotone "already visited" marker and cannot loop on the same rows.
  ADD COLUMN files_ingested_at timestamptz;

-- The fill-in pass's work queue: pull requests whose file data has never been collected.
CREATE INDEX pull_requests_files_pending_idx
  ON pull_requests (workspace_id, repository_id, merged_at DESC)
  WHERE files_ingested_at IS NULL;
