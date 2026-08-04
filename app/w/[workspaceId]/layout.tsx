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
  // The shell renders on every workspace page, so its two reads go together (design.md D2).
  const [workspace, workspaces] = await Promise.all([
    getWorkspace(db(), workspaceId),
    workspacesForCurrentUser(),
  ]);

  return (
    <div className="shell">
      <header className="topbar">
        <Link className="brand" href={`/w/${workspaceId}`}>
          TRACKER
        </Link>
        {/* The workspace in view, secondary to the wordmark. Omitted rather than rendered empty
            when the workspace read comes back undefined. */}
        {workspace ? <span className="brand-workspace">{workspace.accountLogin}</span> : null}
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
        <nav>
          {/* Permanent entry point to the workspace list, which is also where another
              installation is started (design.md D4). */}
          <Link href="/dashboard?list=1">Workspaces</Link>
        </nav>
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
