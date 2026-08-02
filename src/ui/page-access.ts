/**
 * Page-level access resolution. A viewer who may not see a workspace gets the same 404 as one
 * asking for a workspace that does not exist (spec: auth-and-access-control).
 */
import { notFound, redirect } from 'next/navigation';
import { AccessDeniedError, type WorkspaceAccess } from '../auth/access';
import { requireWorkspaceAccess } from '../auth/current';
import type { AuthenticatedSession } from '../auth/session';

export async function loadWorkspacePage(
  workspaceId: string,
  options: { requireOwner?: boolean } = {},
): Promise<{ access: WorkspaceAccess; session: AuthenticatedSession }> {
  try {
    return await requireWorkspaceAccess(workspaceId, options);
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      if (error.message === 'Not signed in') {
        redirect(`/signin?returnTo=${encodeURIComponent(`/w/${workspaceId}`)}`);
      }
      notFound();
    }
    throw error;
  }
}
