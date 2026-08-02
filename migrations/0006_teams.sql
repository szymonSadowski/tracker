-- Product-owned teams (design.md D7, spec: tenancy-and-teams). Not mirrored from GitHub teams.

CREATE TABLE teams (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX teams_name_idx ON teams (workspace_id, lower(name));

-- The primary key is (workspace_id, contributor_id): a contributor belongs to at most one team.
-- Deleting a team removes assignments and no pull request data.
CREATE TABLE team_members (
  workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  contributor_id uuid NOT NULL REFERENCES contributors (id) ON DELETE CASCADE,
  team_id        uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  assigned_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, contributor_id)
);

CREATE INDEX team_members_team_idx ON team_members (workspace_id, team_id);
