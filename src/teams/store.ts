/**
 * Teams and the contributor roster (spec: tenancy-and-teams, design.md D7).
 *
 * The roster is derived from activity — accounts that authored or reviewed a pull request in an
 * in-scope repository — not from organization membership, which would fill the surface with
 * zero-activity rows and make it read as a scoreboard. Teams are created here, not mirrored from
 * GitHub, and a contributor belongs to at most one.
 */
import type { WorkspaceScope } from '../db/scope';

export interface TeamRecord {
  id: string;
  name: string;
  memberCount: number;
}

export interface RosterEntry {
  contributorId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
  teamId: string | null;
  teamName: string | null;
  authoredCount: number;
  reviewedCount: number;
}

export class TeamNameTakenError extends Error {
  constructor(name: string) {
    super(`A team named "${name}" already exists in this workspace`);
    this.name = 'TeamNameTakenError';
  }
}

export async function listTeams(scope: WorkspaceScope): Promise<TeamRecord[]> {
  const { rows } = await scope.query<{ id: string; name: string; member_count: number }>(
    `SELECT t.id, t.name,
            (SELECT count(*) FROM team_members m
              WHERE m.workspace_id = t.workspace_id AND m.team_id = t.id)::int AS member_count
       FROM teams t
      WHERE t.workspace_id = :workspace
      ORDER BY t.name`,
  );
  return rows.map((row) => ({ id: row.id, name: row.name, memberCount: row.member_count }));
}

export async function getTeam(
  scope: WorkspaceScope,
  teamId: string,
): Promise<TeamRecord | undefined> {
  return (await listTeams(scope)).find((team) => team.id === teamId);
}

export async function createTeam(scope: WorkspaceScope, name: string): Promise<TeamRecord> {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error('A team needs a name');
  const existing = await scope.query<{ id: string }>(
    'SELECT id FROM teams WHERE workspace_id = :workspace AND lower(name) = lower($1)',
    [trimmed],
  );
  if (existing.rows.length > 0) throw new TeamNameTakenError(trimmed);

  const { rows } = await scope.query<{ id: string; name: string }>(
    'INSERT INTO teams (workspace_id, name) VALUES (:workspace, $1) RETURNING id, name',
    [trimmed],
  );
  return { id: rows[0]!.id, name: rows[0]!.name, memberCount: 0 };
}

export async function renameTeam(
  scope: WorkspaceScope,
  teamId: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error('A team needs a name');
  const clash = await scope.query<{ id: string }>(
    `SELECT id FROM teams
      WHERE workspace_id = :workspace AND lower(name) = lower($1) AND id <> $2`,
    [trimmed, teamId],
  );
  if (clash.rows.length > 0) throw new TeamNameTakenError(trimmed);

  await scope.query(
    'UPDATE teams SET name = $2, updated_at = now() WHERE workspace_id = :workspace AND id = $1',
    [teamId, trimmed],
  );
}

/** Deleting a team returns its contributors to unassigned and deletes no pull request data. */
export async function deleteTeam(scope: WorkspaceScope, teamId: string): Promise<void> {
  await scope.query('DELETE FROM teams WHERE workspace_id = :workspace AND id = $1', [teamId]);
}

/** Assign, reassign, or (with `teamId: null`) unassign a contributor. */
export async function assignContributor(
  scope: WorkspaceScope,
  contributorId: string,
  teamId: string | null,
): Promise<void> {
  if (teamId === null) {
    await scope.query(
      'DELETE FROM team_members WHERE workspace_id = :workspace AND contributor_id = $1',
      [contributorId],
    );
    return;
  }
  await scope.query(
    `INSERT INTO team_members (workspace_id, contributor_id, team_id)
     VALUES (:workspace, $1, $2)
     ON CONFLICT (workspace_id, contributor_id)
       DO UPDATE SET team_id = EXCLUDED.team_id, assigned_at = now()`,
    [contributorId, teamId],
  );
}

/**
 * The roster: every non-bot account with authorship or review activity in an in-scope repository,
 * with its team assignment (null when unassigned).
 */
export async function listRoster(
  scope: WorkspaceScope,
  options: { includeBots?: boolean; unassignedOnly?: boolean } = {},
): Promise<RosterEntry[]> {
  const { rows } = await scope.query<{
    contributor_id: string;
    login: string;
    name: string | null;
    avatar_url: string | null;
    team_id: string | null;
    team_name: string | null;
    authored_count: number;
    reviewed_count: number;
  }>(
    `WITH activity AS (
       SELECT c.id AS contributor_id,
              count(DISTINCT pr.id)::int AS authored_count,
              count(DISTINCT rev.id)::int AS reviewed_count
         FROM contributors c
         LEFT JOIN pull_requests pr
           ON pr.workspace_id = c.workspace_id
          AND pr.author_contributor_id = c.id
          AND EXISTS (SELECT 1 FROM repositories r
                       WHERE r.id = pr.repository_id AND r.in_scope)
         LEFT JOIN pr_reviews rev
           ON rev.workspace_id = c.workspace_id
          AND rev.reviewer_contributor_id = c.id
          AND EXISTS (SELECT 1 FROM pull_requests p2
                       JOIN repositories r2 ON r2.id = p2.repository_id
                      WHERE p2.id = rev.pull_request_id AND r2.in_scope)
        WHERE c.workspace_id = :workspace
          AND ($1::boolean IS TRUE OR c.is_bot = false)
        GROUP BY c.id
     )
     SELECT c.id AS contributor_id, c.login, c.name, c.avatar_url,
            m.team_id, t.name AS team_name,
            a.authored_count, a.reviewed_count
       FROM activity a
       JOIN contributors c ON c.id = a.contributor_id
       LEFT JOIN team_members m ON m.workspace_id = c.workspace_id AND m.contributor_id = c.id
       LEFT JOIN teams t ON t.id = m.team_id
      WHERE (a.authored_count > 0 OR a.reviewed_count > 0)
        AND ($2::boolean IS NOT TRUE OR m.team_id IS NULL)
      -- Alphabetical, never by activity: ordering people by throughput is the ranking
      -- design.md D10 forbids, and a roster is the easiest place to introduce one by accident.
      ORDER BY c.login`,
    [options.includeBots ?? false, options.unassignedOnly ?? false],
  );

  return rows.map((row) => ({
    contributorId: row.contributor_id,
    login: row.login,
    name: row.name,
    avatarUrl: row.avatar_url,
    teamId: row.team_id,
    teamName: row.team_name,
    authoredCount: row.authored_count,
    reviewedCount: row.reviewed_count,
  }));
}

/** Contributors with activity but no team, surfaced rather than silently omitted. */
export async function unassignedContributors(scope: WorkspaceScope): Promise<RosterEntry[]> {
  return listRoster(scope, { unassignedOnly: true });
}
