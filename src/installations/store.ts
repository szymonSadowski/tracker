/** Installation persistence. Credentials are never stored here — only the link to GitHub. */
import type { Queryable } from '../db/driver';

export type InstallationStatus = 'active' | 'needs_attention' | 'suspended' | 'uninstalled';

export interface InstallationRecord {
  id: string;
  workspaceId: string;
  githubInstallationId: number;
  accountNodeId: string;
  accountLogin: string;
  accountType: string;
  repositorySelection: 'selected' | 'all';
  status: InstallationStatus;
  statusReason: string | null;
  uninstalledAt: Date | null;
}

interface InstallationRow {
  id: string;
  workspace_id: string;
  github_installation_id: number;
  account_node_id: string;
  account_login: string;
  account_type: string;
  repository_selection: 'selected' | 'all';
  status: InstallationStatus;
  status_reason: string | null;
  uninstalled_at: Date | null;
}

const toInstallation = (row: InstallationRow): InstallationRecord => ({
  id: row.id,
  workspaceId: row.workspace_id,
  githubInstallationId: Number(row.github_installation_id),
  accountNodeId: row.account_node_id,
  accountLogin: row.account_login,
  accountType: row.account_type,
  repositorySelection: row.repository_selection,
  status: row.status,
  statusReason: row.status_reason,
  uninstalledAt: row.uninstalled_at,
});

export async function findInstallationByGitHubId(
  db: Queryable,
  githubInstallationId: number,
): Promise<InstallationRecord | undefined> {
  const { rows } = await db.query<InstallationRow>(
    'SELECT * FROM installations WHERE github_installation_id = $1',
    [githubInstallationId],
  );
  return rows[0] ? toInstallation(rows[0]) : undefined;
}

export async function findInstallationByWorkspace(
  db: Queryable,
  workspaceId: string,
): Promise<InstallationRecord | undefined> {
  const { rows } = await db.query<InstallationRow>(
    'SELECT * FROM installations WHERE workspace_id = $1',
    [workspaceId],
  );
  return rows[0] ? toInstallation(rows[0]) : undefined;
}

export interface InstallationInput {
  workspaceId: string;
  githubInstallationId: number;
  accountNodeId: string;
  accountLogin: string;
  accountType: string;
  repositorySelection: 'selected' | 'all';
  installedByUserId?: string | null;
}

/**
 * One installation row per workspace. Re-installing an account — which yields a *new* GitHub
 * installation id — updates the existing row rather than creating a duplicate workspace
 * (spec: github-app-installation).
 */
export async function upsertInstallation(
  db: Queryable,
  input: InstallationInput,
): Promise<InstallationRecord> {
  const existing = await findInstallationByWorkspace(db, input.workspaceId);
  if (existing) {
    const { rows } = await db.query<InstallationRow>(
      `UPDATE installations
          SET github_installation_id = $2, account_node_id = $3, account_login = $4,
              account_type = $5, repository_selection = $6, status = 'active', status_reason = NULL,
              uninstalled_at = NULL,
              installed_by_user_id = COALESCE($7, installed_by_user_id),
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        existing.id,
        input.githubInstallationId,
        input.accountNodeId,
        input.accountLogin,
        input.accountType,
        input.repositorySelection,
        input.installedByUserId ?? null,
      ],
    );
    return toInstallation(rows[0]!);
  }

  const { rows } = await db.query<InstallationRow>(
    `INSERT INTO installations
       (workspace_id, github_installation_id, account_node_id, account_login, account_type,
        repository_selection, installed_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (github_installation_id) DO UPDATE
       SET account_login = EXCLUDED.account_login,
           repository_selection = EXCLUDED.repository_selection,
           status = 'active', status_reason = NULL, uninstalled_at = NULL, updated_at = now()
     RETURNING *`,
    [
      input.workspaceId,
      input.githubInstallationId,
      input.accountNodeId,
      input.accountLogin,
      input.accountType,
      input.repositorySelection,
      input.installedByUserId ?? null,
    ],
  );
  return toInstallation(rows[0]!);
}

export async function setInstallationStatus(
  db: Queryable,
  installationId: string,
  status: InstallationStatus,
  reason?: string | null,
): Promise<void> {
  await db.query(
    `UPDATE installations
        SET status = $2, status_reason = $3,
            uninstalled_at = CASE WHEN $2 = 'uninstalled' THEN now() ELSE NULL END,
            updated_at = now()
      WHERE id = $1`,
    [installationId, status, reason ?? null],
  );
}

export async function listActiveInstallations(db: Queryable): Promise<InstallationRecord[]> {
  const { rows } = await db.query<InstallationRow>(
    `SELECT i.* FROM installations i
       JOIN workspaces w ON w.id = i.workspace_id
      WHERE i.status = 'active' AND w.deleted_at IS NULL`,
  );
  return rows.map(toInstallation);
}
