import Link from 'next/link';
import { loadConfig } from '@/config/env';
import { db } from '@/db/client';
import { workspaceScope } from '@/db/scope';
import { loadWorkspacePage } from '@/ui/page-access';
import {
  periodOfDays,
  teamMetrics,
  unassignedActivity,
  type MetricScope,
} from '@/analysis/aggregate';
import { listTeams, unassignedContributors } from '@/teams/store';
import { installationForWorkspace } from '@/installations/service';
import { listRepositories, syncStatus } from '@/repositories/store';
import {
  Card,
  ColdStart,
  DataCompleteness,
  MetricCard,
  PeriodSelector,
  Section,
  SizeDistribution,
} from '@/ui/components';
import {
  coverageNote,
  formatCount,
  formatDuration,
  formatNumber,
  PERIOD_OPTIONS,
  parsePeriodDays,
} from '@/ui/format';

/**
 * The team view: aggregates over a team's pull requests for a chosen period. There is
 * deliberately no ranking of team members here or in the API behind it (design.md D10).
 */
export default async function TeamViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ period?: string; team?: string }>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const { access } = await loadWorkspacePage(workspaceId);
  const scope = workspaceScope(db(), workspaceId);

  const installation = await installationForWorkspace(db(), workspaceId);
  const repositories = await listRepositories(db(), workspaceId, { inScopeOnly: true });
  const status = await syncStatus(db(), workspaceId);
  const teams = await listTeams(scope);
  const days = parsePeriodDays(query.period);
  const period = periodOfDays(days);
  const isOwner = access.role === 'owner';
  const appSlug = loadConfig().github.appSlug;

  if (!installation || installation.status === 'uninstalled') {
    return (
      <main>
        <h1>Team</h1>
        <ColdStart
          title="No GitHub App installation"
          action={
            appSlug
              ? {
                  href: `https://github.com/apps/${appSlug}/installations/new`,
                  label: 'Install on GitHub',
                }
              : undefined
          }
        >
          This workspace has no active installation, so there is nothing to read from GitHub yet.
        </ColdStart>
      </main>
    );
  }

  if (installation.status !== 'active') {
    return (
      <main>
        <h1>Team</h1>
        <ColdStart
          title="The GitHub connection needs attention"
          action={
            isOwner
              ? { href: `/w/${workspaceId}/settings`, label: 'Reconnect the installation' }
              : undefined
          }
        >
          GitHub is no longer accepting this installation&rsquo;s credentials
          {installation.statusReason ? `: ${installation.statusReason}` : ''}. Syncing is paused
          until it is reconnected.
        </ColdStart>
      </main>
    );
  }

  if (repositories.length === 0) {
    return (
      <main>
        <h1>Team</h1>
        <ColdStart
          title="No repositories selected"
          action={{ href: `/w/${workspaceId}/settings`, label: 'Choose repositories' }}
        >
          The installation is connected but no repository is in scope, so no pull requests are being
          ingested.
        </ColdStart>
      </main>
    );
  }

  if (teams.length === 0) {
    const roster = await unassignedContributors(scope);
    return (
      <main>
        <h1>Team</h1>
        <DataCompleteness {...status} isOwner={isOwner} />
        <ColdStart
          title="No teams yet"
          action={isOwner ? { href: `/w/${workspaceId}/teams`, label: 'Create a team' } : undefined}
        >
          {roster.length} contributor{roster.length === 1 ? '' : 's'} have activity in the selected
          repositories. Group them into a team to see team metrics.
        </ColdStart>
      </main>
    );
  }

  const selectedTeam = teams.find((team) => team.id === query.team) ?? teams[0]!;
  const filter: MetricScope = {
    period,
    repositoryIds: access.visibleRepositoryIds,
    teamId: selectedTeam.id,
  };
  const metrics = await teamMetrics(scope, filter);
  const outside = await unassignedActivity(scope, {
    period,
    repositoryIds: access.visibleRepositoryIds,
  });
  const drillThrough = `/w/${workspaceId}/pulls?period=${days}&team=${selectedTeam.id}`;

  return (
    <main>
      <h1>{selectedTeam.name}</h1>
      <p className="muted">
        {selectedTeam.memberCount} contributor{selectedTeam.memberCount === 1 ? '' : 's'} ·{' '}
        {access.visibleRepositories.length} of {repositories.length} repositories visible to you
      </p>

      {teams.length > 1 ? (
        <div className="period">
          <span className="muted">Team:</span>
          {teams.map((team) => (
            <Link
              key={team.id}
              className={team.id === selectedTeam.id ? 'chip chip-active' : 'chip'}
              href={`/w/${workspaceId}?period=${days}&team=${team.id}`}
            >
              {team.name}
            </Link>
          ))}
        </div>
      ) : null}

      <PeriodSelector
        days={days}
        options={PERIOD_OPTIONS}
        basePath={`/w/${workspaceId}`}
        extraQuery={`&team=${selectedTeam.id}`}
      />

      <DataCompleteness {...status} isOwner={isOwner} />

      <div className="cards">
        <Card
          label="Merged pull requests"
          value={formatCount(metrics.mergedCount)}
          note={`opened in period: ${metrics.openedCount}`}
          href={drillThrough}
        />
        <MetricCard
          label="Median cycle time"
          summary={metrics.cycleTime}
          format={formatDuration}
          href={drillThrough}
        />
        <MetricCard
          label="Median time to first review"
          summary={metrics.timeToFirstReview}
          format={formatDuration}
          href={drillThrough}
        />
        <MetricCard
          label="Median time to approval"
          summary={metrics.timeToApproval}
          format={formatDuration}
        />
        <Card
          label="Median review rounds"
          value={formatNumber(metrics.medianReviewCycles)}
          note={coverageNote(metrics.mergedCount, metrics.mergedCount)}
        />
      </div>

      <Section title="Change size">
        <SizeDistribution distribution={metrics.sizeDistribution} />
      </Section>

      {outside.mergedCount > 0 ? (
        <p className="notice">
          {outside.contributors} contributor{outside.contributors === 1 ? '' : 's'} with{' '}
          {outside.mergedCount} merged pull request{outside.mergedCount === 1 ? '' : 's'} in this
          period are not assigned to any team, and are not included in the totals above.{' '}
          {isOwner ? <Link href={`/w/${workspaceId}/teams`}>Assign them</Link> : null}
        </p>
      ) : null}

      <p className="muted" style={{ marginTop: '1.5rem' }}>
        Metrics are team aggregates. Individual contributors are not ranked against one another;
        each person can see their own work under &ldquo;My work&rdquo;.
      </p>
    </main>
  );
}
