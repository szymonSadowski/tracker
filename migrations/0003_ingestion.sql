-- Raw and normalized ingestion layers (spec: github-data-sync, design.md D1/D4).

-- Verbatim GitHub payloads, so normalized and derived data can be rebuilt without the API.
-- Keyed by content hash: re-ingesting an identical payload updates fetched_at rather than
-- appending a second copy, which keeps replay a true no-op.
CREATE TABLE github_raw_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  repository_id  uuid REFERENCES repositories (id) ON DELETE SET NULL,
  source         text NOT NULL CHECK (source IN ('graphql_backfill', 'rest_incremental', 'webhook')),
  entity_type    text NOT NULL,
  entity_node_id text NOT NULL,
  payload        jsonb NOT NULL,
  payload_hash   text NOT NULL,
  entity_updated_at timestamptz,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  fetched_at     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX github_raw_events_hash_idx
  ON github_raw_events (workspace_id, entity_node_id, payload_hash);
CREATE INDEX github_raw_events_entity_idx
  ON github_raw_events (workspace_id, entity_type, entity_node_id, fetched_at DESC);
CREATE INDEX github_raw_events_repo_idx ON github_raw_events (workspace_id, repository_id);

-- The roster: accounts discovered from authorship and review activity (design.md D7).
CREATE TABLE contributors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  node_id        text NOT NULL,
  github_user_id bigint,
  login          text NOT NULL,
  name           text,
  avatar_url     text,
  account_type   text NOT NULL DEFAULT 'User',
  -- Classified at ingest from GitHub's account type; excluded from aggregates by default.
  is_bot         boolean NOT NULL DEFAULT false,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX contributors_node_idx ON contributors (workspace_id, node_id);
CREATE INDEX contributors_login_idx ON contributors (workspace_id, lower(login));

CREATE TABLE pull_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  repository_id         uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  node_id               text NOT NULL,
  number                integer NOT NULL,
  title                 text NOT NULL DEFAULT '',
  url                   text,
  state                 text NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
  is_draft              boolean NOT NULL DEFAULT false,
  author_contributor_id uuid REFERENCES contributors (id) ON DELETE SET NULL,
  base_ref              text,
  head_ref              text,
  additions             integer,
  deletions             integer,
  changed_files         integer,
  opened_at             timestamptz NOT NULL,
  -- NULL while still a draft; equals opened_at when the pull request never was one.
  ready_for_review_at   timestamptz,
  first_commit_at       timestamptz,
  closed_at             timestamptz,
  merged_at             timestamptz,
  github_updated_at     timestamptz NOT NULL,
  ingested_at           timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX pull_requests_node_idx ON pull_requests (workspace_id, node_id);
CREATE INDEX pull_requests_repo_idx ON pull_requests (workspace_id, repository_id, github_updated_at DESC);
CREATE INDEX pull_requests_author_idx ON pull_requests (workspace_id, author_contributor_id);
CREATE INDEX pull_requests_merged_idx ON pull_requests (workspace_id, merged_at);

CREATE TABLE pr_reviews (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  pull_request_id         uuid NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,
  node_id                 text NOT NULL,
  reviewer_contributor_id uuid REFERENCES contributors (id) ON DELETE SET NULL,
  state                   text NOT NULL,
  body_present            boolean NOT NULL DEFAULT false,
  submitted_at            timestamptz NOT NULL
);

CREATE UNIQUE INDEX pr_reviews_node_idx ON pr_reviews (workspace_id, node_id);
CREATE INDEX pr_reviews_pr_idx ON pr_reviews (workspace_id, pull_request_id, submitted_at);

CREATE TABLE pr_commits (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  pull_request_id       uuid NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,
  node_id               text NOT NULL,
  oid                   text,
  author_contributor_id uuid REFERENCES contributors (id) ON DELETE SET NULL,
  message_headline      text,
  additions             integer,
  deletions             integer,
  changed_files         integer,
  authored_at           timestamptz,
  committed_at          timestamptz NOT NULL
);

CREATE UNIQUE INDEX pr_commits_node_idx ON pr_commits (workspace_id, pull_request_id, node_id);
CREATE INDEX pr_commits_pr_idx ON pr_commits (workspace_id, pull_request_id, committed_at);

-- Timeline events. Review effort is computed from these rather than from surviving commit
-- identifiers, so a force-push does not corrupt the numbers (design.md risks).
CREATE TABLE pr_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  pull_request_id       uuid NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,
  event_type            text NOT NULL,
  occurred_at           timestamptz NOT NULL,
  actor_contributor_id  uuid REFERENCES contributors (id) ON DELETE SET NULL,
  -- Stable within a pull request so replaying a window re-writes the same row.
  dedupe_key            text NOT NULL,
  details               jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX pr_events_dedupe_idx ON pr_events (workspace_id, pull_request_id, dedupe_key);
CREATE INDEX pr_events_pr_idx ON pr_events (workspace_id, pull_request_id, occurred_at);

-- One row per sync attempt, per repository (spec: "Sync state is observable").
CREATE TABLE sync_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  repository_id       uuid REFERENCES repositories (id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('backfill', 'incremental', 'reprocess')),
  status              text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'paused')),
  window_start        timestamptz,
  window_end          timestamptz,
  cursor              text,
  pull_requests_seen  integer NOT NULL DEFAULT 0,
  error               text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz
);

CREATE INDEX sync_runs_repo_idx ON sync_runs (workspace_id, repository_id, started_at DESC);
