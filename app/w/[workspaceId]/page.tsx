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
  ContributorThroughputChart,
  CumulativeThroughputChart,
  MAX_SELECTED_AUTHORS,
  CycleTimePhaseChart,
  DistributionView,
  ThroughputChart,
  WorkMixView,
} from '@/ui/metric-charts';
import {
  contributorThroughputSeries,
  mergeEventSeries,
  metricDistribution,
  metricSeries,
  workMixSeries,
} from '@/analysis/series';
import { assignTiers, loadBenchmarkThresholds } from '@/analysis/benchmarks';
import { loadMetricSettings } from '@/analysis/settings';
import { loadClassificationSettings } from '@/classification/store';
import { coverageStart, listCoverage } from '@/repositories/coverage';

/**
 * The team view: aggregates over a team's pull requests for a chosen period. There is deliberately
 * no ranking of team members here or in the API behind it (design.md D10). The per-author
 * throughput chart is the one per-person comparison on this page: merged counts in name order, and
 * counts only — no latency, size, or churn is broken down per person here.
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
    /** Comma-separated contributor ids drawn on the per-author throughput chart. */
    authors?: string;
  }>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const { access } = await loadWorkspacePage(workspaceId);
  const scope = workspaceScope(db(), workspaceId);

  // Independent of one another, so issued together (design.md D2).
  const [installation, repositories, status, teams] = await Promise.all([
    installationForWorkspace(db(), workspaceId),
    listRepositories(db(), workspaceId, { inScopeOnly: true }),
    syncStatus(db(), workspaceId),
    listTeams(scope),
  ]);
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
  const drillThrough = `/w/${workspaceId}/pulls?period=${days}&team=${selectedTeam.id}`;
  const granularity = parseGranularity(query.granularity, days);
  const churnAbsolute = query.churn === 'lines';

  // Everything below reads the same rollup layer the tiles above read, so a chart and a tile can
  // never disagree about the same metric (design.md D3). The reads themselves are independent, so
  // they go in two rounds: what nothing depends on, then what needs the first round's answers.
  const [metrics, outside, settings, coverage, thresholds, classificationSettings] =
    await Promise.all([
      teamMetrics(scope, filter),
      unassignedActivity(scope, { period, repositoryIds: access.visibleRepositoryIds }),
      loadMetricSettings(db(), workspaceId),
      listCoverage(db(), workspaceId, { repositoryIds: access.visibleRepositoryIds }),
      loadBenchmarkThresholds(db()),
      loadClassificationSettings(db(), workspaceId),
    ]);
  const churnCoverage = coverageStart(
    coverage.filter((record) => record.dataClass === 'file_diffs'),
    access.visibleRepositoryIds,
  );

  const [
    buckets,
    churnBuckets,
    sizeDistribution,
    cycleDistribution,
    workMix,
    authorThroughput,
    mergeEvents,
  ] = await Promise.all([
    metricSeries(scope, filter, {
      granularity,
      settings,
      coverageStart: status.coverageStart,
    }),
    metricSeries(scope, filter, {
      granularity,
      settings,
      // Churn coverage lags pull request coverage while the file fill-in runs, so the churn chart
      // marks its own buckets rather than inheriting the pull request coverage start.
      coverageStart: churnCoverage.start,
    }),
    metricDistribution(scope, filter, { metric: 'size', settings }),
    metricDistribution(scope, filter, { metric: 'cycle_time', settings }),
    classificationSettings.enabled
      ? workMixSeries(scope, filter, {
          granularity,
          settings,
          confidenceThreshold: classificationSettings.confidenceThreshold,
        })
      : Promise.resolve([]),
    contributorThroughputSeries(scope, filter, {
      granularity,
      settings,
      coverageStart: status.coverageStart,
    }),
    // The same team scope as the bucketed per-author chart, at per-pull-request resolution. Both
    // charts then draw from one selection, so they cannot describe different people.
    mergeEventSeries(scope, filter, { settings, coverageStart: status.coverageStart }),
  ]);

  // The refactor share over the whole period, so the seeded `refactor_rate` band is read rather
  // than carried. Over the period's lines rather than an average of bucket shares: a quiet week
  // would otherwise weigh as much as a busy one.
  const churnLines = churnBuckets.reduce(
    (totals, bucket) => ({
      refactor: totals.refactor + (bucket.churn?.refactorLines ?? 0),
      all:
        totals.all +
        (bucket.churn
          ? bucket.churn.newCodeLines + bucket.churn.refactorLines + bucket.churn.reworkLines
          : 0),
    }),
    { refactor: 0, all: 0 },
  );

  const period75 = {
    cycle_time: metrics.cycleTime.p75,
    pr_throughput:
      buckets.length > 0 ? (buckets.at(-1)?.throughputPerContributorDay ?? null) : null,
    refactor_rate: churnLines.all > 0 ? churnLines.refactor / churnLines.all : null,
  };
  const benchmarks = assignTiers(period75, thresholds);
  const needsFocusBound = (metric: string): number | null =>
    thresholds.find((threshold) => threshold.metric === metric && threshold.tier === 'needs_focus')
      ?.lowerBound ?? null;
  const reworkThreshold = needsFocusBound('rework_rate');
  const refactorThreshold = needsFocusBound('refactor_rate');

  const chartQuery = `period=${days}&team=${selectedTeam.id}`;

  // Which authors the per-author chart draws. Ids that no longer appear in the period are dropped
  // rather than held in the URL, so a link shared across a period change degrades to a valid view
  // instead of an empty one. With no parameter at all the chart opens on the first few authors in
  // name order — a default that is arbitrary on purpose, since any other rule would be a ranking.
  const knownAuthors = new Set(authorThroughput.contributors.map((entry) => entry.contributorId));
  const requestedAuthors = (query.authors ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => knownAuthors.has(id));
  const selectedAuthors = (
    query.authors === undefined
      ? authorThroughput.contributors.map((entry) => entry.contributorId)
      : requestedAuthors
  ).slice(0, MAX_SELECTED_AUTHORS);

  const authorsHref = (contributorId: string): string => {
    const next = selectedAuthors.includes(contributorId)
      ? selectedAuthors.filter((id) => id !== contributorId)
      : [...selectedAuthors, contributorId];
    const base = `/w/${workspaceId}?${chartQuery}&granularity=${granularity}&churn=${
      churnAbsolute ? 'lines' : 'shares'
    }`;
    // An empty selection still needs to be expressible, or deselecting the last author would fall
    // back to the default and redraw the line the viewer just removed.
    return `${base}&authors=${next.join(',')}`;
  };

  // Every other control carries the whole state, so changing one does not silently reset another:
  // switching granularity used to drop the author selection and the churn unit.
  const authorsQuery = query.authors === undefined ? '' : `&authors=${selectedAuthors.join(',')}`;
  const churnQuery = `&churn=${churnAbsolute ? 'lines' : 'shares'}`;

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
            query={`${chartQuery}${churnQuery}${authorsQuery}`}
          />
        }
      >
        <ThroughputChart
          buckets={buckets}
          drillThrough={drillThrough}
          benchmark={benchmarks.pr_throughput}
        />
        <ContributorThroughputChart
          data={authorThroughput}
          selected={selectedAuthors}
          hrefFor={authorsHref}
          drillThrough={drillThrough}
        />
        {/* The same authors as the chart above, so the two never describe different people. */}
        <CumulativeThroughputChart
          data={mergeEvents}
          periodStart={period.start}
          periodEnd={period.end}
          selected={selectedAuthors}
          timeZone={settings.timeZone}
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
          }${authorsQuery}`}
          coveredFrom={churnCoverage.start}
          reworkThreshold={reworkThreshold}
          refactorThreshold={refactorThreshold}
          refactorBenchmark={benchmarks.refactor_rate}
          reworkRecencyDays={settings.reworkRecencyDays}
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
