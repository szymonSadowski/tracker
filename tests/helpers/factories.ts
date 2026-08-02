/**
 * Factories for seeding pull request data. Defaults describe an ordinary merged pull request;
 * every field a test cares about is overridable.
 */
import type { Queryable } from '../../src/db/driver';

let counter = 0;
const next = () => ++counter;

export const BASE_TIME = new Date('2026-05-01T09:00:00.000Z');

export function at(hoursFromBase: number, from: Date = BASE_TIME): Date {
  return new Date(from.getTime() + hoursFromBase * 3600_000);
}

export function hours(n: number): number {
  return n * 3600;
}

export interface SeededWorkspace {
  id: string;
  accountLogin: string;
  accountNodeId: string;
}

export async function seedWorkspace(
  db: Queryable,
  overrides: Partial<{
    name: string;
    accountLogin: string;
    accountNodeId: string;
    accountType: string;
  }> = {},
): Promise<SeededWorkspace> {
  const n = next();
  const accountLogin = overrides.accountLogin ?? `acme-${n}`;
  const accountNodeId = overrides.accountNodeId ?? `O_account_${n}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO workspaces (name, account_node_id, account_login, account_type)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      overrides.name ?? accountLogin,
      accountNodeId,
      accountLogin,
      overrides.accountType ?? 'Organization',
    ],
  );
  return { id: rows[0]!.id, accountLogin, accountNodeId };
}

export async function seedInstallation(
  db: Queryable,
  workspaceId: string,
  overrides: Partial<{
    githubInstallationId: number;
    status: string;
    accountLogin: string;
    accountNodeId: string;
  }> = {},
): Promise<{ id: string; githubInstallationId: number }> {
  const n = next();
  const githubInstallationId = overrides.githubInstallationId ?? 100000 + n;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO installations
       (workspace_id, github_installation_id, account_node_id, account_login, account_type, status)
     VALUES ($1, $2, $3, $4, 'Organization', $5) RETURNING id`,
    [
      workspaceId,
      githubInstallationId,
      overrides.accountNodeId ?? `O_account_${n}`,
      overrides.accountLogin ?? `acme-${n}`,
      overrides.status ?? 'active',
    ],
  );
  return { id: rows[0]!.id, githubInstallationId };
}

export async function seedRepository(
  db: Queryable,
  workspaceId: string,
  overrides: Partial<{
    nodeId: string;
    name: string;
    ownerLogin: string;
    inScope: boolean;
    backfillState: string;
    syncedThrough: Date | null;
  }> = {},
): Promise<{ id: string; nodeId: string; fullName: string }> {
  const n = next();
  const name = overrides.name ?? `repo-${n}`;
  const ownerLogin = overrides.ownerLogin ?? 'acme';
  const nodeId = overrides.nodeId ?? `R_repo_${n}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO repositories
       (workspace_id, node_id, github_repo_id, owner_login, name, full_name, in_scope,
        backfill_state, synced_through)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      workspaceId,
      nodeId,
      200000 + n,
      ownerLogin,
      name,
      `${ownerLogin}/${name}`,
      overrides.inScope ?? true,
      overrides.backfillState ?? 'complete',
      overrides.syncedThrough ?? null,
    ],
  );
  return { id: rows[0]!.id, nodeId, fullName: `${ownerLogin}/${name}` };
}

export async function seedContributor(
  db: Queryable,
  workspaceId: string,
  overrides: Partial<{ login: string; nodeId: string; isBot: boolean; accountType: string }> = {},
): Promise<{ id: string; login: string; nodeId: string }> {
  const n = next();
  const login = overrides.login ?? `dev-${n}`;
  const nodeId = overrides.nodeId ?? `U_user_${n}`;
  const isBot = overrides.isBot ?? false;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO contributors (workspace_id, node_id, github_user_id, login, account_type, is_bot)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      workspaceId,
      nodeId,
      300000 + n,
      login,
      overrides.accountType ?? (isBot ? 'Bot' : 'User'),
      isBot,
    ],
  );
  return { id: rows[0]!.id, login, nodeId };
}

export interface SeedPullRequestOptions {
  workspaceId: string;
  repositoryId: string;
  authorContributorId?: string | null;
  nodeId?: string;
  number?: number;
  title?: string;
  state?: 'open' | 'closed' | 'merged';
  isDraft?: boolean;
  openedAt?: Date;
  readyForReviewAt?: Date | null;
  mergedAt?: Date | null;
  closedAt?: Date | null;
  githubUpdatedAt?: Date;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
}

export async function seedPullRequest(
  db: Queryable,
  options: SeedPullRequestOptions,
): Promise<{ id: string; nodeId: string; number: number }> {
  const n = next();
  const openedAt = options.openedAt ?? BASE_TIME;
  const state = options.state ?? 'merged';
  const mergedAt =
    options.mergedAt !== undefined ? options.mergedAt : state === 'merged' ? at(6, openedAt) : null;
  const nodeId = options.nodeId ?? `PR_pull_${n}`;
  const number = options.number ?? n;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO pull_requests
       (workspace_id, repository_id, node_id, number, title, url, state, is_draft,
        author_contributor_id, additions, deletions, changed_files, opened_at,
        ready_for_review_at, closed_at, merged_at, github_updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [
      options.workspaceId,
      options.repositoryId,
      nodeId,
      number,
      options.title ?? `Pull request ${number}`,
      `https://github.com/acme/repo/pull/${number}`,
      state,
      options.isDraft ?? false,
      options.authorContributorId ?? null,
      options.additions ?? 40,
      options.deletions ?? 10,
      options.changedFiles ?? 3,
      openedAt,
      options.readyForReviewAt !== undefined ? options.readyForReviewAt : openedAt,
      options.closedAt ?? mergedAt,
      mergedAt,
      options.githubUpdatedAt ?? mergedAt ?? openedAt,
    ],
  );
  return { id: rows[0]!.id, nodeId, number };
}

export async function seedReview(
  db: Queryable,
  options: {
    workspaceId: string;
    pullRequestId: string;
    reviewerContributorId?: string | null;
    state?: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
    submittedAt: Date;
    nodeId?: string;
  },
): Promise<{ id: string }> {
  const n = next();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO pr_reviews
       (workspace_id, pull_request_id, node_id, reviewer_contributor_id, state, submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      options.workspaceId,
      options.pullRequestId,
      options.nodeId ?? `PRR_review_${n}`,
      options.reviewerContributorId ?? null,
      options.state ?? 'COMMENTED',
      options.submittedAt,
    ],
  );
  return { id: rows[0]!.id };
}

export async function seedCommit(
  db: Queryable,
  options: {
    workspaceId: string;
    pullRequestId: string;
    committedAt: Date;
    authorContributorId?: string | null;
    nodeId?: string;
    additions?: number;
    deletions?: number;
  },
): Promise<{ id: string }> {
  const n = next();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO pr_commits
       (workspace_id, pull_request_id, node_id, oid, author_contributor_id, additions, deletions,
        authored_at, committed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      options.workspaceId,
      options.pullRequestId,
      options.nodeId ?? `C_commit_${n}`,
      options.nodeId ?? `sha${n}`,
      options.authorContributorId ?? null,
      options.additions ?? 10,
      options.deletions ?? 2,
      options.committedAt,
      options.committedAt,
    ],
  );
  return { id: rows[0]!.id };
}

export async function seedEvent(
  db: Queryable,
  options: {
    workspaceId: string;
    pullRequestId: string;
    eventType: string;
    occurredAt: Date;
    actorContributorId?: string | null;
    dedupeKey?: string;
  },
): Promise<void> {
  const n = next();
  await db.query(
    `INSERT INTO pr_events
       (workspace_id, pull_request_id, event_type, occurred_at, actor_contributor_id, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      options.workspaceId,
      options.pullRequestId,
      options.eventType,
      options.occurredAt,
      options.actorContributorId ?? null,
      options.dedupeKey ?? `${options.eventType}:${n}`,
    ],
  );
}

export async function seedUser(
  db: Queryable,
  overrides: Partial<{ login: string; githubUserId: number; githubNodeId: string }> = {},
): Promise<{ id: string; login: string; githubUserId: number; githubNodeId: string }> {
  const n = next();
  const login = overrides.login ?? `user-${n}`;
  const githubUserId = overrides.githubUserId ?? 400000 + n;
  const githubNodeId = overrides.githubNodeId ?? `U_user_${n}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (github_user_id, github_node_id, login) VALUES ($1,$2,$3) RETURNING id`,
    [githubUserId, githubNodeId, login],
  );
  return { id: rows[0]!.id, login, githubUserId, githubNodeId };
}

export async function seedMembership(
  db: Queryable,
  workspaceId: string,
  userId: string,
  role: 'owner' | 'member' = 'member',
): Promise<void> {
  await db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1,$2,$3)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [workspaceId, userId, role],
  );
}

export async function seedTeam(
  db: Queryable,
  workspaceId: string,
  name?: string,
): Promise<{ id: string; name: string }> {
  const n = next();
  const teamName = name ?? `Team ${n}`;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO teams (workspace_id, name) VALUES ($1,$2) RETURNING id`,
    [workspaceId, teamName],
  );
  return { id: rows[0]!.id, name: teamName };
}
