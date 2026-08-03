-- Coverage per class of data (spec: github-data-sync "A repository records how far back its
-- coverage extends", design.md D5).
--
-- Pull request coverage and file-level coverage move at different speeds: the file fill-in pass
-- runs below incremental sync and extends backwards for as long as it takes. One marker per
-- repository would report churn as covered merely because the pull requests are.

CREATE TABLE repository_coverage (
  workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  data_class    text NOT NULL
                CHECK (data_class IN ('pull_requests', 'file_diffs', 'default_branch_commits')),
  -- Earliest point from which this class is known complete. A floor, not a description of the row
  -- set: rows older than it may exist because they were touched inside a bounded window.
  covered_from  timestamptz,
  -- True once the walk for this class reached the repository's earliest record.
  complete      boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (workspace_id, repository_id, data_class)
);

-- `repositories.history_covered_from` stays as the pull request class's own store — the history
-- sync writes it and existing surfaces read it — and is mirrored here so every class is read
-- through one table.
INSERT INTO repository_coverage (workspace_id, repository_id, data_class, covered_from, complete)
SELECT r.workspace_id, r.id, 'pull_requests', r.history_covered_from, r.history_complete
  FROM repositories r
 WHERE r.history_covered_from IS NOT NULL OR r.history_complete = true;
