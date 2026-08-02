/**
 * Installation lifecycle (spec: github-app-installation).
 *
 * Everything here runs in one transaction with the jobs it enqueues, so a repository can never
 * enter scope without its backfill being queued, and can never leave scope with its sync still
 * pending.
 */
import type { Database, Queryable } from '../db/driver';
import { cancelPendingJobs, enqueue } from '../jobs/queue';
import {
  deselectRepository,
  listRepositories,
  upsertRepository,
  type RepositoryInput,
} from '../repositories/store';
import { addMember, upsertWorkspaceForAccount } from '../workspaces/store';
import {
  findInstallationByGitHubId,
  findInstallationByWorkspace,
  setInstallationStatus,
  upsertInstallation,
  type InstallationRecord,
} from './store';

export interface InstallationAccount {
  nodeId: string;
  login: string;
  type: string;
}

export interface RecordInstallationInput {
  githubInstallationId: number;
  account: InstallationAccount;
  repositorySelection: 'selected' | 'all';
  repositories: RepositoryInput[];
  installedByUserId?: string | null;
}

export interface ReconcileResult {
  added: string[];
  removed: string[];
  renamed: { from: string; to: string }[];
  backfillsEnqueued: number;
}

export interface RecordInstallationResult extends ReconcileResult {
  workspaceId: string;
  installationId: string;
  workspaceCreated: boolean;
}

/**
 * Persist an installation callback: workspace, installation, repository scope, and the installing
 * user's ownership — creating none of them twice if the account is already installed.
 */
export async function recordInstallation(
  database: Database,
  input: RecordInstallationInput,
): Promise<RecordInstallationResult> {
  return database.transaction(async (tx) => {
    const existingWorkspace = await tx.query<{ id: string }>(
      'SELECT id FROM workspaces WHERE account_node_id = $1 AND deleted_at IS NULL',
      [input.account.nodeId],
    );
    const workspaceCreated = existingWorkspace.rows.length === 0;

    const workspace = await upsertWorkspaceForAccount(tx, input.account);
    const installation = await upsertInstallation(tx, {
      workspaceId: workspace.id,
      githubInstallationId: input.githubInstallationId,
      accountNodeId: input.account.nodeId,
      accountLogin: input.account.login,
      accountType: input.account.type,
      repositorySelection: input.repositorySelection,
      installedByUserId: input.installedByUserId ?? null,
    });

    if (input.installedByUserId) {
      await addMember(tx, workspace.id, input.installedByUserId, 'owner');
    }

    const reconciled = await reconcileRepositoriesIn(tx, workspace.id, input.repositories);

    return {
      workspaceId: workspace.id,
      installationId: installation.id,
      workspaceCreated,
      ...reconciled,
    };
  });
}

/**
 * Bring the stored repository scope in line with what GitHub reports.
 *
 * Added repositories are recorded and backfilled; removed ones stop syncing, drop out of
 * aggregates, and keep their data; renamed ones update in place because the key is the node id.
 */
export async function reconcileRepositoriesIn(
  tx: Queryable,
  workspaceId: string,
  repositories: RepositoryInput[],
): Promise<ReconcileResult> {
  const result: ReconcileResult = { added: [], removed: [], renamed: [], backfillsEnqueued: 0 };
  const seenNodeIds = new Set<string>();

  for (const input of repositories) {
    seenNodeIds.add(input.nodeId);
    const { repository, created, renamedFrom } = await upsertRepository(tx, workspaceId, input);
    if (renamedFrom) result.renamed.push({ from: renamedFrom, to: repository.fullName });
    if (created || repository.backfillState === 'pending') {
      if (created) result.added.push(repository.fullName);
      const job = await enqueue(tx, {
        workspaceId,
        type: 'repository.backfill',
        payload: { repositoryId: repository.id },
        dedupeKey: `backfill:${repository.id}`,
        priority: 50,
      });
      if (job) result.backfillsEnqueued++;
    }
  }

  for (const existing of await listRepositories(tx, workspaceId, { inScopeOnly: true })) {
    if (seenNodeIds.has(existing.nodeId)) continue;
    await deselectRepository(tx, workspaceId, existing.id);
    await cancelRepositoryJobs(tx, workspaceId, existing.id, 'repository deselected');
    result.removed.push(existing.fullName);
  }

  // A changed selection changes who can see what; the cache must not outlive it.
  await invalidatePermissionCache(tx, workspaceId);

  return result;
}

export async function reconcileRepositories(
  database: Database,
  workspaceId: string,
  repositories: RepositoryInput[],
): Promise<ReconcileResult> {
  return database.transaction((tx) => reconcileRepositoriesIn(tx, workspaceId, repositories));
}

async function cancelRepositoryJobs(
  db: Queryable,
  workspaceId: string,
  repositoryId: string,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE jobs
        SET state = 'cancelled', last_error = $3, finished_at = now(), updated_at = now()
      WHERE workspace_id = $1 AND state = 'pending' AND payload->>'repositoryId' = $2`,
    [workspaceId, repositoryId, reason],
  );
}

export async function invalidatePermissionCache(db: Queryable, workspaceId: string): Promise<void> {
  await db.query('DELETE FROM repository_permissions WHERE workspace_id = $1', [workspaceId]);
}

/**
 * GitHub rejected the App's credentials. Park the installation so owners are told to reconnect,
 * and stop scheduling work that can only fail (spec: github-app-installation).
 */
export async function markInstallationNeedsAttention(
  database: Database,
  workspaceId: string,
  reason: string,
): Promise<void> {
  await database.transaction(async (tx) => {
    const installation = await findInstallationByWorkspace(tx, workspaceId);
    if (!installation || installation.status === 'uninstalled') return;
    await setInstallationStatus(tx, installation.id, 'needs_attention', reason.slice(0, 500));
    await cancelPendingJobs(
      tx,
      workspaceId,
      `installation needs attention: ${reason.slice(0, 200)}`,
    );
  });
}

/**
 * The App was removed on GitHub: stop all processing, discard credentials, keep the data readable
 * to the workspace's members.
 */
export async function markInstallationUninstalled(
  database: Database,
  githubInstallationId: number,
  options: { onCredentialsDiscarded?: (githubInstallationId: number) => void } = {},
): Promise<{ workspaceId: string; cancelledJobs: number } | undefined> {
  return database.transaction(async (tx) => {
    const installation = await findInstallationByGitHubId(tx, githubInstallationId);
    if (!installation) return undefined;
    await setInstallationStatus(tx, installation.id, 'uninstalled', 'uninstalled on GitHub');
    const cancelledJobs = await cancelPendingJobs(
      tx,
      installation.workspaceId,
      'installation uninstalled',
    );
    await invalidatePermissionCache(tx, installation.workspaceId);
    options.onCredentialsDiscarded?.(githubInstallationId);
    return { workspaceId: installation.workspaceId, cancelledJobs };
  });
}

/** Suspension is reversible and behaves like needs-attention while it lasts. */
export async function markInstallationSuspended(
  database: Database,
  githubInstallationId: number,
): Promise<void> {
  await database.transaction(async (tx) => {
    const installation = await findInstallationByGitHubId(tx, githubInstallationId);
    if (!installation) return;
    await setInstallationStatus(tx, installation.id, 'suspended', 'suspended on GitHub');
    await cancelPendingJobs(tx, installation.workspaceId, 'installation suspended');
  });
}

export async function installationForWorkspace(
  db: Queryable,
  workspaceId: string,
): Promise<InstallationRecord | undefined> {
  return findInstallationByWorkspace(db, workspaceId);
}
