import Link from 'next/link';
import type { ReactNode } from 'react';
import { db } from '@/db/client';
import { loadWorkspacePage } from '@/ui/page-access';
import { workspacesForCurrentUser } from '@/auth/current';
import { getWorkspace } from '@/workspaces/store';

/** Application shell: navigation, workspace switching, and sign-out. */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { access } = await loadWorkspacePage(workspaceId);
  const workspace = await getWorkspace(db(), workspaceId);
  const workspaces = await workspacesForCurrentUser();

  return (
    <div className="shell">
      <header className="topbar">
        <Link className="brand" href={`/w/${workspaceId}`}>
          {workspace?.accountLogin ?? 'Tracker'}
        </Link>
        <nav>
          <Link href={`/w/${workspaceId}`}>Team</Link>
          <Link href={`/w/${workspaceId}/pulls`}>Pull requests</Link>
          <Link href={`/w/${workspaceId}/me`}>My work</Link>
          {access.role === 'owner' ? (
            <>
              <Link href={`/w/${workspaceId}/teams`}>Teams</Link>
              <Link href={`/w/${workspaceId}/settings`}>Settings</Link>
            </>
          ) : null}
        </nav>
        <span className="spacer" />
        {workspaces.length > 1 ? (
          <nav>
            {workspaces
              .filter((candidate) => candidate.id !== workspaceId)
              .map((candidate) => (
                <Link key={candidate.id} href={`/w/${candidate.id}`}>
                  Switch to {candidate.accountLogin}
                </Link>
              ))}
          </nav>
        ) : null}
        <form action="/api/auth/signout" method="post" className="inline-form">
          <button className="button button-secondary" type="submit">
            Sign out
          </button>
        </form>
      </header>
      {children}
    </div>
  );
}
