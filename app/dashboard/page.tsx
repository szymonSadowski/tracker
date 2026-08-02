import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadConfig } from '@/config/env';
import { currentSession, workspacesForCurrentUser } from '@/auth/current';
import { ColdStart } from '@/ui/components';

/** Landing: go to the user's workspace, or explain how to create one. */
export default async function DashboardPage() {
  const session = await currentSession();
  if (!session) redirect('/signin');

  const workspaces = await workspacesForCurrentUser();
  if (workspaces.length === 1) redirect(`/w/${workspaces[0]!.id}`);
  if (workspaces.length > 1) {
    return (
      <main className="shell">
        <h1>Your workspaces</h1>
        <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              <Link className="card card-link" href={`/w/${workspace.id}`}>
                <span className="card-label">{workspace.role}</span>
                <span className="card-value" style={{ fontSize: '1.1rem' }}>
                  {workspace.accountLogin}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </main>
    );
  }

  const slug = loadConfig().github.appSlug;
  return (
    <main className="shell">
      <h1>Welcome, {session.user.login}</h1>
      <ColdStart
        title="No workspace yet"
        action={
          slug
            ? {
                href: `https://github.com/apps/${slug}/installations/new`,
                label: 'Install on GitHub',
              }
            : undefined
        }
      >
        You are not a member of a workspace. Install the GitHub App on an organization and select
        the repositories to track — that creates a workspace and makes you its owner.
      </ColdStart>
    </main>
  );
}
