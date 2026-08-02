import { loadConfig } from '@/config/env';
import { db } from '@/db/client';
import { loadWorkspacePage } from '@/ui/page-access';
import { installationForWorkspace } from '@/installations/service';
import { listRepositories, syncStatus } from '@/repositories/store';
import { listMembers } from '@/workspaces/store';
import { CoverageState, DataCompleteness, Section } from '@/ui/components';
import { formatDate, relativeTime } from '@/ui/format';
import { HistorySyncControl } from './history-sync';
import { SyncNowButton } from './sync-now';

/** Installation settings: repository scope, connection health, and sync state. Owner only. */
export default async function SettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  await loadWorkspacePage(workspaceId, { requireOwner: true });

  const installation = await installationForWorkspace(db(), workspaceId);
  const repositories = await listRepositories(db(), workspaceId);
  const status = await syncStatus(db(), workspaceId);
  const members = await listMembers(db(), workspaceId);
  const slug = loadConfig().github.appSlug;
  const configureUrl = installation
    ? `https://github.com/settings/installations/${installation.githubInstallationId}`
    : slug
      ? `https://github.com/apps/${slug}/installations/new`
      : undefined;

  return (
    <main>
      <h1>Settings</h1>

      <Section title="GitHub App installation">
        {installation ? (
          <>
            <p className="muted">
              Installed on {installation.accountLogin} · status: {installation.status}
              {installation.statusReason ? ` (${installation.statusReason})` : ''} · repository
              selection: {installation.repositorySelection}
            </p>
            {installation.status === 'needs_attention' ? (
              <p className="notice notice-warn">
                GitHub rejected this installation&rsquo;s credentials, so syncing is paused.
                Reconnect it on GitHub to resume.
              </p>
            ) : null}
            {configureUrl ? (
              <a className="button" href={configureUrl} target="_blank" rel="noreferrer">
                Manage repositories on GitHub
              </a>
            ) : null}
          </>
        ) : (
          <p className="muted">No installation is connected to this workspace.</p>
        )}
      </Section>

      <Section title="Sync">
        <p className="muted">
          Connecting a repository ingests its recent history; older pull requests are only fetched
          when asked for here.
        </p>
        <SyncNowButton workspaceId={workspaceId} />
      </Section>

      <Section title="History">
        <HistorySyncControl workspaceId={workspaceId} />
      </Section>

      <Section title="Repositories">
        <DataCompleteness {...status} isOwner />
        <table>
          <thead>
            <tr>
              <th>Repository</th>
              <th>In scope</th>
              <th>Backfill</th>
              <th>Data from</th>
              <th>Last successful sync</th>
              <th>Last error</th>
            </tr>
          </thead>
          <tbody>
            {repositories.map((repository) => (
              <tr key={repository.id}>
                <td>{repository.fullName}</td>
                <td>{repository.inScope ? 'yes' : 'no — data retained'}</td>
                <td>{repository.backfillState}</td>
                <td>
                  <CoverageState
                    coverage={{
                      coveredFrom: repository.historyCoveredFrom,
                      historyComplete: repository.historyComplete,
                      historyState: repository.historyState,
                      historyError: repository.historyError,
                    }}
                  />
                </td>
                <td className="numeric">
                  {repository.lastSuccessAt ? formatDate(repository.lastSuccessAt) : 'never'}
                  {repository.lastSuccessAt ? (
                    <span className="muted"> ({relativeTime(repository.lastSuccessAt)})</span>
                  ) : null}
                </td>
                <td className={repository.lastError ? '' : 'absent'}>
                  {repository.lastError ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Members">
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Rights</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.userId}>
                <td>{member.login}</td>
                <td>{member.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ marginTop: '0.5rem' }}>
          Members see only the repositories they can read on GitHub; there is no second permission
          model here.
        </p>
      </Section>
    </main>
  );
}
