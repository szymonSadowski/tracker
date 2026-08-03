-- Default-branch commits (spec: github-data-sync "Default-branch commits are ingested
-- independently of pull requests", design.md D5).
--
-- Commit activity becomes a real series rather than a by-product of pull request ingestion: a
-- commit pushed straight to the default branch appears here without any pull request record.

CREATE TABLE repository_commits (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  repository_id         uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  oid                   text NOT NULL,
  node_id               text,
  author_contributor_id uuid REFERENCES contributors (id) ON DELETE SET NULL,
  committed_at          timestamptz NOT NULL,
  additions             integer,
  deletions             integer,
  changed_files         integer,
  message_headline      text,
  -- The same commit reached through a pull request resolves to this one record, associated with
  -- both (spec: "A commit is reachable both through a pull request and the default branch").
  pull_request_id       uuid REFERENCES pull_requests (id) ON DELETE SET NULL,
  -- A rewritten default branch marks its orphaned commits unreachable rather than deleting them,
  -- so history stays explainable and the rows can be re-linked if the branch is restored.
  reachable             boolean NOT NULL DEFAULT true,
  first_seen_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX repository_commits_oid_idx ON repository_commits (workspace_id, repository_id, oid);
CREATE INDEX repository_commits_activity_idx
  ON repository_commits (workspace_id, repository_id, committed_at)
  WHERE reachable = true;
CREATE INDEX repository_commits_author_idx
  ON repository_commits (workspace_id, author_contributor_id, committed_at);
