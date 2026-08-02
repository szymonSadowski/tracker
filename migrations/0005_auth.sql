-- Identity, sessions, workspace membership, and the repository permission cache
-- (spec: auth-and-access-control, design.md D8).

-- Users are global; membership binds them to workspaces. Identity is the GitHub account id, so a
-- rename preserves history.
CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  github_user_id bigint NOT NULL UNIQUE,
  github_node_id text NOT NULL UNIQUE,
  login          text NOT NULL,
  name           text,
  avatar_url     text,
  email          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  -- The stored id is a hash of the cookie value; the raw token is never persisted.
  id             text PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The user's GitHub OAuth token, used for permission checks against GitHub on their behalf.
  github_token   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz
);

CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'member')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

-- Short-lived cache of "may this user read this repository on GitHub" (D8).
CREATE TABLE repository_permissions (
  workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  can_read      boolean NOT NULL,
  checked_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, user_id, repository_id)
);

CREATE INDEX repository_permissions_expiry_idx ON repository_permissions (workspace_id, expires_at);
