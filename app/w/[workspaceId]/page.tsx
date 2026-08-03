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
  CoverageNotice,
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
  parseGranularity,
  parsePeriodDays,
} from '@/ui/format';
import { GranularitySelector } from '@/ui/charts';
import {
  ChurnChart,
  CommitActivityChart,
  CycleTimePhaseChart,
  DistributionView,
  ThroughputChart,
  WorkMixView,
} from '@/ui/metric-charts';
import { metricDistribution, metricSeries, workMixSeries } from '@/analysis/series';
import { assignTiers, loadBenchmarkThresholds } from '@/analysis/benchmarks';
import { loadMetricSettings } from '@/analysis/settings';
import { loadClassificationSettings } from '@/classification/store';
import { coverageStart, listCoverage } from '@/repositories/coverage';

/**
 * The team view: aggregates over a team's pull requests for a chosen period. There is
 * deliberately no ranking of team members here or in the API behind it (design.md D10).
 */
export default async function TeamViewPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{
    period?: string;
    team?: string;
    granularity?: string;
    churn?: string;
  }>;
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

  // Everything below reads the same rollup layer the tiles above read, so a chart and a tile can
  // never disagree about the same metric (design.md D3).
  const settings = await loadMetricSettings(db(), workspaceId);
  const granularity = parseGranularity(query.granularity, days);
  const churnAbsolute = query.churn === 'lines';
  const coverage = await listCoverage(db(), workspaceId, {
    repositoryIds: access.visibleRepositoryIds,
  });
  const churnCoverage = coverageStart(
    coverage.filter((record) => record.dataClass === 'file_diffs'),
    access.visibleRepositoryIds,
  );

  const buckets = await metricSeries(scope, filter, {
    granularity,
    settings,
    coverageStart: status.coverageStart,
  });
  const churnBuckets = await metricSeries(scope, filter, {
    granularity,
    settings,
    // Churn coverage lags pull request coverage while the file fill-in runs, so the churn chart
    // marks its own buckets rather than inheriting the pull request coverage start.
    coverageStart: churnCoverage.start,
  });
  const thresholds = await loadBenchmarkThresholds(db());
  const period75 = {
    cycle_time: metrics.cycleTime.p75,
    pr_throughput: buckets.length > 0 ? (buckets.at(-1)?.throughputPerContributorDay ?? null) : null,
  };
  const benchmarks = assignTiers(period75, thresholds);
  const reworkThreshold =
    thresholds.find(
      (threshold) => threshold.metric === 'rework_rate' && threshold.tier === 'needs_focus',
    )?.lowerBound ?? null;

  const sizeDistribution = await metricDistribution(scope, filter, { metric: 'size', settings });
  const cycleDistribution = await metricDistribution(scope, filter, {
    metric: 'cycle_time',
    settings,
  });

  const classificationSettings = await loadClassificationSettings(db(), workspaceId);
  const workMix = classificationSettings.enabled
    ? await workMixSeries(scope, filter, {
        granularity,
        settings,
        confidenceThreshold: classificationSettings.confidenceThreshold,
      })
    : [];

  const chartQuery = `period=${days}&team=${selectedTeam.id}`;

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
      <CoverageNotice
        periodStart={period.start}
        coverageStart={status.coverageStart}
        historySyncing={status.historySyncing}
        historySyncHref={isOwner ? `/w/${workspaceId}/settings` : undefined}
      />

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

      <Section
        title="Trends"
        aside={
          <GranularitySelector
            granularity={granularity}
            basePath={`/w/${workspaceId}`}
            query={chartQuery}
          />
        }
      >
        <ThroughputChart
          buckets={buckets}
          drillThrough={drillThrough}
          benchmark={benchmarks.pr_throughput}
        />
        <CycleTimePhaseChart
          buckets={buckets}
          drillThrough={drillThrough}
          benchmark={benchmarks.cycle_time}
        />
        <ChurnChart
          buckets={churnBuckets}
          drillThrough={drillThrough}
          absolute={churnAbsolute}
          toggleHref={`/w/${workspaceId}?${chartQuery}&granularity=${granularity}&churn=${
            churnAbsolute ? 'shares' : 'lines'
          }`}
          coveredFrom={churnCoverage.start}
          reworkThreshold={reworkThreshold}
        />
        <CommitActivityChart
          buckets={buckets}
          filterNote={`Across the ${access.visibleRepositories.length} repositories visible to you, for ${selectedTeam.name}.`}
        />
      </Section>

      <Section title="Distributions">
        <DistributionView
          title="Pull request size"
          description="Lines changed per merged pull request."
          histogram={sizeDistribution}
          format={(value) => formatCount(value === null ? null : Math.round(value))}
        />
        <DistributionView
          title="Cycle time"
          description="First commit to merge."
          histogram={cycleDistribution}
          format={formatDuration}
        />
      </Section>

      <Section title="Work mix">
        <WorkMixView
          buckets={workMix}
          enabled={classificationSettings.enabled}
          drillThrough={drillThrough}
          settingsHref={isOwner ? `/w/${workspaceId}/settings` : undefined}
        />
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
