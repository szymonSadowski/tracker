-- Workspaces, GitHub App installations, and the repositories in scope
-- (spec: github-app-installation, tenancy-and-teams).

CREATE TABLE workspaces (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  -- The GitHub account the installation targets. Node id is the stable identity; the login is
  -- display only and may change.
  account_node_id      text NOT NULL,
  account_login        text NOT NULL,
  account_type         text NOT NULL CHECK (account_type IN ('Organization', 'User')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);

CREATE UNIQUE INDEX workspaces_account_idx ON workspaces (account_node_id) WHERE deleted_at IS NULL;

CREATE TABLE installations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL UNIQUE REFERENCES workspaces (id) ON DELETE CASCADE,
  github_installation_id bigint NOT NULL UNIQUE,
  account_node_id        text NOT NULL,
  account_login          text NOT NULL,
  account_type           text NOT NULL,
  repository_selection   text NOT NULL DEFAULT 'selected'
                         CHECK (repository_selection IN ('selected', 'all')),
  -- 'needs_attention' means GitHub rejected our credentials; no work is scheduled for it.
  status                 text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'needs_attention', 'suspended', 'uninstalled')),
  status_reason          text,
  installed_by_user_id   uuid,
  installed_at           timestamptz NOT NULL DEFAULT now(),
  uninstalled_at         timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE repositories (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- Immutable GitHub identity: renames and transfers update the name, never the key.
  node_id        text NOT NULL,
  github_repo_id bigint,
  owner_login    text NOT NULL,
  name           text NOT NULL,
  full_name      text NOT NULL,
  is_private     boolean NOT NULL DEFAULT true,
  default_branch text,
  -- Deselected repositories keep their data but leave every aggregate.
  in_scope       boolean NOT NULL DEFAULT true,
  added_at       timestamptz NOT NULL DEFAULT now(),
  removed_at     timestamptz,
  -- Sync bookkeeping (spec: github-data-sync "Sync state is observable").
  backfill_state        text NOT NULL DEFAULT 'pending'
                        CHECK (backfill_state IN ('pending', 'in_progress', 'complete', 'failed')),
  backfill_cursor       text,
  backfill_window_start timestamptz,
  backfill_started_at   timestamptz,
  backfill_completed_at timestamptz,
  last_sync_at          timestamptz,
  last_success_at       timestamptz,
  last_failure_at       timestamptz,
  last_error            text,
  consecutive_failures  integer NOT NULL DEFAULT 0,
  -- High-water mark for incremental sync; the next window starts before it on purpose.
  synced_through        timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX repositories_node_idx ON repositories (workspace_id, node_id);
CREATE INDEX repositories_in_scope_idx ON repositories (workspace_id, in_scope);
