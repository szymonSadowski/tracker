/**
 * User identity (spec: auth-and-access-control, design.md D8).
 *
 * Users are keyed by their GitHub account id, so renaming an account preserves both the identity
 * and the link to its pull request history. That key is also what links a signed-in user to their
 * contributor record — there is no mapping step to get wrong.
 */
import type { Queryable } from '../db/driver';

export interface UserRecord {
  id: string;
  githubUserId: number;
  githubNodeId: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

interface UserRow {
  id: string;
  github_user_id: number;
  github_node_id: string;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

const toUser = (row: UserRow): UserRecord => ({
  id: row.id,
  githubUserId: Number(row.github_user_id),
  githubNodeId: row.github_node_id,
  login: row.login,
  name: row.name,
  avatarUrl: row.avatar_url,
});

export interface GitHubProfile {
  githubUserId: number;
  githubNodeId: string;
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
  email?: string | null;
}

/** Create or refresh the user for a GitHub profile. The account id is the identity. */
export async function upsertUser(db: Queryable, profile: GitHubProfile): Promise<UserRecord> {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (github_user_id, github_node_id, login, name, avatar_url, email)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (github_user_id) DO UPDATE
       SET github_node_id = EXCLUDED.github_node_id,
           login = EXCLUDED.login,
           name = COALESCE(EXCLUDED.name, users.name),
           avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
           email = COALESCE(EXCLUDED.email, users.email),
           updated_at = now()
     RETURNING *`,
    [
      profile.githubUserId,
      profile.githubNodeId,
      profile.login,
      profile.name ?? null,
      profile.avatarUrl ?? null,
      profile.email ?? null,
    ],
  );
  return toUser(rows[0]!);
}

export async function getUser(db: Queryable, userId: string): Promise<UserRecord | undefined> {
  const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  return rows[0] ? toUser(rows[0]) : undefined;
}

export async function findUserByGitHubId(
  db: Queryable,
  githubUserId: number,
): Promise<UserRecord | undefined> {
  const { rows } = await db.query<UserRow>('SELECT * FROM users WHERE github_user_id = $1', [
    githubUserId,
  ]);
  return rows[0] ? toUser(rows[0]) : undefined;
}

/**
 * The contributor record for this user in this workspace, matched on the GitHub account id. A
 * contributor exists only if the account has authored or reviewed a pull request in scope.
 */
export async function contributorForUser(
  db: Queryable,
  workspaceId: string,
  user: Pick<UserRecord, 'githubUserId' | 'githubNodeId'>,
): Promise<{ id: string; login: string } | undefined> {
  const { rows } = await db.query<{ id: string; login: string }>(
    `SELECT id, login FROM contributors
      WHERE workspace_id = $1 AND (node_id = $2 OR github_user_id = $3)
      ORDER BY (node_id = $2) DESC
      LIMIT 1`,
    [workspaceId, user.githubNodeId, user.githubUserId],
  );
  return rows[0];
}
