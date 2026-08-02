/**
 * Request-scoped authentication for the Next.js app: cookie → session → workspace access.
 * Every server component and route handler that reads workspace data goes through here, so the
 * access check cannot be skipped by rendering the data a different way.
 */
import { cookies } from 'next/headers';
import { loadConfig } from '../config/env';
import { db } from '../db/client';
import {
  AccessDeniedError,
  GitHubPermissionChecker,
  resolveWorkspaceAccess,
  type PermissionChecker,
  type WorkspaceAccess,
} from './access';
import { resolveSession, SESSION_COOKIE, type AuthenticatedSession } from './session';
import { listWorkspacesForUser } from '../workspaces/store';

export async function currentSession(): Promise<AuthenticatedSession | undefined> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const config = loadConfig();
  return resolveSession(db(), token, {
    inactivityMinutes: config.auth.sessionInactivityMinutes,
  });
}

export async function requireSession(): Promise<AuthenticatedSession> {
  const session = await currentSession();
  if (!session) throw new AccessDeniedError('Not signed in');
  return session;
}

function checkerFor(session: AuthenticatedSession): PermissionChecker {
  const config = loadConfig();
  if (!session.session.githubToken) {
    // No user token means we cannot ask GitHub anything on their behalf; deny rather than assume.
    return { canRead: async () => false };
  }
  return new GitHubPermissionChecker(session.session.githubToken, config.github.apiBaseUrl);
}

export async function requireWorkspaceAccess(
  workspaceId: string,
  options: { requireOwner?: boolean } = {},
): Promise<{ access: WorkspaceAccess; session: AuthenticatedSession }> {
  const session = await requireSession();
  const config = loadConfig();
  const access = await resolveWorkspaceAccess(db(), {
    workspaceId,
    user: session.user,
    checker: checkerFor(session),
    permissionCacheSeconds: config.auth.permissionCacheSeconds,
    requireOwner: options.requireOwner,
  });
  return { access, session };
}

/** The workspaces this user belongs to, for the workspace switcher and the default landing. */
export async function workspacesForCurrentUser() {
  const session = await currentSession();
  if (!session) return [];
  return listWorkspacesForUser(db(), session.user.id);
}
