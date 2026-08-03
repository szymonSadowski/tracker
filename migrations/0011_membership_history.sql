-- Membership history (spec: metric-aggregation "The contributor denominator is prorated over
-- partial membership", design.md D4).
--
-- `team_members` records who is on a team now. Prorating a throughput denominator across joins,
-- departures, and team moves needs intervals, which is what these tables hold. `ended_at` NULL
-- means the membership is open.

CREATE TABLE team_memberships (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  team_id        uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  contributor_id uuid NOT NULL REFERENCES contributors (id) ON DELETE CASCADE,
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX team_memberships_overlap_idx
  ON team_memberships (workspace_id, team_id, started_at, ended_at);
CREATE INDEX team_memberships_contributor_idx
  ON team_memberships (workspace_id, contributor_id, started_at);

CREATE TABLE workspace_memberships (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  contributor_id uuid NOT NULL REFERENCES contributors (id) ON DELETE CASCADE,
  started_at     timestamptz NOT NULL,
  ended_at       timestamptz,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX workspace_memberships_overlap_idx
  ON workspace_memberships (workspace_id, started_at, ended_at);
CREATE INDEX workspace_memberships_contributor_idx
  ON workspace_memberships (workspace_id, contributor_id, started_at);

-- Backfill from current membership. `first_seen_at` is the earliest defensible start we can claim
-- from data we hold (design.md D4); bots never enter a denominator, so they are not seeded.
INSERT INTO workspace_memberships (workspace_id, contributor_id, started_at)
SELECT c.workspace_id, c.id, c.first_seen_at
  FROM contributors c
 WHERE c.is_bot = false;

INSERT INTO team_memberships (workspace_id, team_id, contributor_id, started_at)
SELECT tm.workspace_id, tm.team_id, tm.contributor_id, c.first_seen_at
  FROM team_members tm
  JOIN contributors c ON c.id = tm.contributor_id
 WHERE c.is_bot = false;
