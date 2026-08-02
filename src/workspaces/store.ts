/** Workspace and membership persistence. */
import type { Queryable } from '../db/driver';

export interface WorkspaceRecord {
  id: string;
  name: string;
  accountNodeId: string;
  accountLogin: string;
  accountType: string;
  deletedAt: Date | null;
}

interface WorkspaceRow {
  id: string;
  name: string;
  account_node_id: string;
  account_login: string;
  account_type: string;
  deleted_at: Date | null;
}

const toWorkspace = (row: WorkspaceRow): WorkspaceRecord => ({
  id: row.id,
  name: row.name,
  accountNodeId: row.account_node_id,
  accountLogin: row.account_login,
  accountType: row.account_type,
  deletedAt: row.deleted_at,
});

export async function findWorkspaceByAccount(
  db: Queryable,
  accountNodeId: string,
): Promise<WorkspaceRecord | undefined> {
  const { rows } = await db.query<WorkspaceRow>(
    'SELECT * FROM workspaces WHERE account_node_id = $1 AND deleted_at IS NULL',
    [accountNodeId],
  );
  return rows[0] ? toWorkspace(rows[0]) : undefined;
}

export async function getWorkspace(
  db: Queryable,
  workspaceId: string,
): Promise<WorkspaceRecord | undefined> {
  const { rows } = await db.query<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [
    workspaceId,
  ]);
  return rows[0] ? toWorkspace(rows[0]) : undefined;
}

/** Create the workspace for an account, or refresh the display fields of the existing one. */
export async function upsertWorkspaceForAccount(
  db: Queryable,
  account: { nodeId: string; login: string; type: string },
): Promise<WorkspaceRecord> {
  const { rows } = await db.query<WorkspaceRow>(
    `INSERT INTO workspaces (name, account_node_id, account_login, account_type)
     VALUES ($1, $2, $1, $3)
     ON CONFLICT (account_node_id) WHERE deleted_at IS NULL
     DO UPDATE SET account_login = EXCLUDED.account_login,
                   account_type = EXCLUDED.account_type,
                   updated_at = now()
     RETURNING *`,
    [account.login, account.nodeId, account.type],
  );
  return toWorkspace(rows[0]!);
}

export async function addMember(
  db: Queryable,
  workspaceId: string,
  userId: string,
  role: 'owner' | 'member',
): Promise<void> {
  await db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [workspaceId, userId, role],
  );
}

export async function removeMember(
  db: Queryable,
  workspaceId: string,
  userId: string,
): Promise<void> {
  await db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
    workspaceId,
    userId,
  ]);
}

export interface MembershipRecord {
  workspaceId: string;
  userId: string;
  role: 'owner' | 'member';
}

export async function getMembership(
  db: Queryable,
  workspaceId: string,
  userId: string,
): Promise<MembershipRecord | undefined> {
  const { rows } = await db.query<{
    workspace_id: string;
    user_id: string;
    role: 'owner' | 'member';
  }>(
    'SELECT workspace_id, user_id, role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId],
  );
  const row = rows[0];
  return row ? { workspaceId: row.workspace_id, userId: row.user_id, role: row.role } : undefined;
}

export async function listWorkspacesForUser(
  db: Queryable,
  userId: string,
): Promise<(WorkspaceRecord & { role: 'owner' | 'member' })[]> {
  const { rows } = await db.query<WorkspaceRow & { role: 'owner' | 'member' }>(
    `SELECT w.*, m.role
       FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.user_id = $1 AND w.deleted_at IS NULL
      ORDER BY w.account_login`,
    [userId],
  );
  return rows.map((row) => ({ ...toWorkspace(row), role: row.role }));
}

export async function listMembers(
  db: Queryable,
  workspaceId: string,
): Promise<{ userId: string; login: string; role: 'owner' | 'member' }[]> {
  const { rows } = await db.query<{ user_id: string; login: string; role: 'owner' | 'member' }>(
    `SELECT m.user_id, u.login, m.role
       FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 ORDER BY u.login`,
    [workspaceId],
  );
  return rows.map((row) => ({ userId: row.user_id, login: row.login, role: row.role }));
}
