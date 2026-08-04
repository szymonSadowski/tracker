import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadConfig } from '@/config/env';
import { currentSession, workspacesForCurrentUser } from '@/auth/current';
import { ColdStart } from '@/ui/components';

/** Landing: go to the user's workspace, or explain how to create one. */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ list?: string }>;
}) {
  const session = await currentSession();
  if (!session) redirect('/signin');

  // Sign-in is the common entry, so one workspace still goes straight through; the list is a
  // deliberate destination (`?list=1`) reached from the topbar (design.md D3).
  const listRequested = (await searchParams).list === '1';
  const workspaces = await workspacesForCurrentUser();
  if (workspaces.length === 1 && !listRequested) redirect(`/w/${workspaces[0]!.id}`);

  const slug = loadConfig().github.appSlug;
  const installUrl = slug ? `https://github.com/apps/${slug}/installations/new` : undefined;

  if (workspaces.length > 0) {
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
        <p className="muted">
          Each GitHub account you install the App on gets its own workspace; installing on another
          account adds a workspace rather than repositories to an existing one.
        </p>
        {installUrl ? (
          <a className="button" href={installUrl} target="_blank" rel="noreferrer">
            Install on another GitHub account
          </a>
        ) : (
          <p className="muted">
            No GitHub App slug is configured here, so an additional installation must be started
            from the App&rsquo;s own page on GitHub.
          </p>
        )}
      </main>
    );
  }

  return (
    <main className="shell">
      <h1>Welcome, {session.user.login}</h1>
      <ColdStart
        title="No workspace yet"
        action={installUrl ? { href: installUrl, label: 'Install on GitHub' } : undefined}
      >
        You are not a member of a workspace. Install the GitHub App on an organization and select
        the repositories to track — that creates a workspace and makes you its owner.
      </ColdStart>
    </main>
  );
}
