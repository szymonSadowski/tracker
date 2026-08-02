import Link from 'next/link';
import { db } from '@/db/client';
import { workspaceScope } from '@/db/scope';
import { loadWorkspacePage } from '@/ui/page-access';
import { listPullRequests, periodOfDays, type MetricScope } from '@/analysis/aggregate';
import { listTeams, listRoster } from '@/teams/store';
import { syncStatus } from '@/repositories/store';
import { CoverageNotice, PeriodSelector } from '@/ui/components';
import { SyncRepositoryButton } from './sync-repository';
import {
  formatDate,
  formatDuration,
  PERIOD_OPTIONS,
  parsePeriodDays,
  UNAVAILABLE,
} from '@/ui/format';

/**
 * The pull requests behind the metrics, filterable by repository, author, team, and state. Opened
 * from a team metric, it contains exactly the set that metric was computed from.
 */
export default async function PullRequestsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{
    period?: string;
    team?: string;
    repository?: string;
    author?: string;
    state?: string;
  }>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const { access } = await loadWorkspacePage(workspaceId);
  const scope = workspaceScope(db(), workspaceId);

  const days = parsePeriodDays(query.period);
  const period = periodOfDays(days);
  const status = await syncStatus(db(), workspaceId);
  const teams = await listTeams(scope);
  const roster = await listRoster(scope);

  // A repository filter can only narrow what the viewer may already see.
  const repositoryIds = query.repository
    ? access.visibleRepositoryIds.filter((id) => id === query.repository)
    : access.visibleRepositoryIds;
  // Undefined unless exactly one visible repository is selected — which is when syncing just that
  // one is a meaningful thing to offer.
  const selectedRepository = access.visibleRepositories.find((r) => r.id === query.repository);

  const state = query.state === 'open' || query.state === 'closed' ? query.state : 'merged';
  const filter: MetricScope = {
    period,
    repositoryIds,
    teamId: query.team ?? null,
    contributorId: query.author,
  };
  const pullRequests = await listPullRequests(scope, filter, {
    merged: state === 'merged',
    state,
  });

  const link = (overrides: Record<string, string | undefined>) => {
    const next = new URLSearchParams({
      period: String(days),
      ...(query.team ? { team: query.team } : {}),
      ...(query.repository ? { repository: query.repository } : {}),
      ...(query.author ? { author: query.author } : {}),
      ...(state !== 'merged' ? { state } : {}),
    });
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) next.delete(key);
      else next.set(key, value);
    }
    return `/w/${workspaceId}/pulls?${next.toString()}`;
  };

  return (
    <main>
      <h1>Pull requests</h1>
      <p className="muted">
        {pullRequests.length} pull request{pullRequests.length === 1 ? '' : 's'}
        {query.team
          ? ` for ${teams.find((team) => team.id === query.team)?.name ?? 'team'}`
          : ''}{' '}
        in the last {days} days
      </p>

      <PeriodSelector days={days} options={PERIOD_OPTIONS} basePath={`/w/${workspaceId}/pulls`} />
      <CoverageNotice
        periodStart={period.start}
        coverageStart={status.coverageStart}
        historySyncing={status.historySyncing}
        historySyncHref={access.role === 'owner' ? `/w/${workspaceId}/settings` : undefined}
      />

      <div className="period">
        <span className="muted">State:</span>
        {(['merged', 'open', 'closed'] as const).map((option) => (
          <Link
            key={option}
            className={option === state ? 'chip chip-active' : 'chip'}
            href={link({ state: option === 'merged' ? undefined : option })}
          >
            {option}
          </Link>
        ))}
      </div>

      <div className="period">
        <span className="muted">Repository:</span>
        <Link
          className={query.repository ? 'chip' : 'chip chip-active'}
          href={link({ repository: undefined })}
        >
          all
        </Link>
        {access.visibleRepositories.map((repository) => (
          <Link
            key={repository.id}
            className={query.repository === repository.id ? 'chip chip-active' : 'chip'}
            href={link({ repository: repository.id })}
          >
            {repository.name}
          </Link>
        ))}
        {selectedRepository ? (
          <SyncRepositoryButton
            workspaceId={workspaceId}
            repositoryId={selectedRepository.id}
            repositoryName={selectedRepository.name}
          />
        ) : null}
      </div>

      <div className="period">
        <span className="muted">Team:</span>
        <Link className={query.team ? 'chip' : 'chip chip-active'} href={link({ team: undefined })}>
          all
        </Link>
        {teams.map((team) => (
          <Link
            key={team.id}
            className={query.team === team.id ? 'chip chip-active' : 'chip'}
            href={link({ team: team.id })}
          >
            {team.name}
          </Link>
        ))}
      </div>

      <div className="period">
        <span className="muted">Author:</span>
        <Link
          className={query.author ? 'chip' : 'chip chip-active'}
          href={link({ author: undefined })}
        >
          all
        </Link>
        {roster.map((entry) => (
          <Link
            key={entry.contributorId}
            className={query.author === entry.contributorId ? 'chip chip-active' : 'chip'}
            href={link({ author: entry.contributorId })}
          >
            {entry.login}
          </Link>
        ))}
      </div>

      {pullRequests.length === 0 ? (
        <p className="notice">No pull requests match these filters in this period.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Pull request</th>
              <th>Repository</th>
              <th>Author</th>
              <th>{state === 'merged' ? 'Merged' : 'Opened'}</th>
              <th>Cycle time</th>
              <th>To first review</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {pullRequests.map((pullRequest) => (
              <tr key={pullRequest.id}>
                <td>
                  {pullRequest.url ? (
                    <a href={pullRequest.url} target="_blank" rel="noreferrer">
                      #{pullRequest.number} {pullRequest.title}
                    </a>
                  ) : (
                    <>
                      #{pullRequest.number} {pullRequest.title}
                    </>
                  )}
                </td>
                <td>{pullRequest.repositoryFullName}</td>
                <td>{pullRequest.authorLogin ?? UNAVAILABLE}</td>
                <td className="numeric">
                  {formatDate(state === 'merged' ? pullRequest.mergedAt : pullRequest.openedAt)}
                </td>
                <td className={`numeric${pullRequest.cycleTimeSeconds === null ? ' absent' : ''}`}>
                  {formatDuration(pullRequest.cycleTimeSeconds)}
                </td>
                <td
                  className={`numeric${
                    pullRequest.timeToFirstReviewSeconds === null ? ' absent' : ''
                  }`}
                >
                  {formatDuration(pullRequest.timeToFirstReviewSeconds)}
                </td>
                <td className="numeric">
                  {pullRequest.sizeBucket?.toUpperCase() ?? UNAVAILABLE}{' '}
                  {pullRequest.additions !== null ? (
                    <span className="muted">
                      +{pullRequest.additions}/−{pullRequest.deletions ?? 0}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
