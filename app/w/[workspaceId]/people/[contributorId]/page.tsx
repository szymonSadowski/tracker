import { notFound } from 'next/navigation';
import { db } from '@/db/client';
import { workspaceScope } from '@/db/scope';
import { AccessDeniedError, assertMayViewContributor } from '@/auth/access';
import { loadWorkspacePage } from '@/ui/page-access';
import {
  listPullRequests,
  periodOfDays,
  teamMetrics,
  type MetricScope,
} from '@/analysis/aggregate';
import { syncStatus } from '@/repositories/store';
import { Card, CoverageNotice, MetricCard, PeriodSelector, Section } from '@/ui/components';
import {
  formatCount,
  formatDate,
  formatDuration,
  PERIOD_OPTIONS,
  parsePeriodDays,
} from '@/ui/format';

/**
 * Per-contributor detail. Restricted to workspace owners and to the contributor themselves
 * (spec: analytics-dashboard) — a member cannot open a colleague's page.
 */
export default async function ContributorPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; contributorId: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { workspaceId, contributorId } = await params;
  const { period: periodParam } = await searchParams;
  const { access } = await loadWorkspacePage(workspaceId);

  try {
    await assertMayViewContributor(db(), access, contributorId);
  } catch (error) {
    if (error instanceof AccessDeniedError) notFound();
    throw error;
  }

  const scope = workspaceScope(db(), workspaceId);
  const { rows } = await scope.query<{ login: string }>(
    'SELECT login FROM contributors WHERE workspace_id = :workspace AND id = $1',
    [contributorId],
  );
  const contributor = rows[0];
  if (!contributor) notFound();

  const days = parsePeriodDays(periodParam);
  const filter: MetricScope = {
    period: periodOfDays(days),
    repositoryIds: access.visibleRepositoryIds,
    contributorId,
  };
  const [metrics, pullRequests, status] = await Promise.all([
    teamMetrics(scope, filter),
    listPullRequests(scope, filter, { limit: 50 }),
    syncStatus(db(), workspaceId),
  ]);

  return (
    <main>
      <h1>{contributor.login}</h1>
      <PeriodSelector
        days={days}
        options={PERIOD_OPTIONS}
        basePath={`/w/${workspaceId}/people/${contributorId}`}
      />
      <CoverageNotice
        periodStart={filter.period.start}
        coverageStart={status.coverageStart}
        historySyncing={status.historySyncing}
        historySyncHref={access.role === 'owner' ? `/w/${workspaceId}/settings` : undefined}
      />

      <div className="cards">
        <Card label="Merged pull requests" value={formatCount(metrics.mergedCount)} />
        <MetricCard label="Median cycle time" summary={metrics.cycleTime} format={formatDuration} />
        <MetricCard
          label="Median time to first review"
          summary={metrics.timeToFirstReview}
          format={formatDuration}
        />
      </div>

      <Section title="Pull requests">
        {pullRequests.length === 0 ? (
          <p className="notice">No merged pull requests in this period.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Pull request</th>
                <th>Repository</th>
                <th>Merged</th>
                <th>Cycle time</th>
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
                      `#${pullRequest.number} ${pullRequest.title}`
                    )}
                  </td>
                  <td>{pullRequest.repositoryFullName}</td>
                  <td className="numeric">{formatDate(pullRequest.mergedAt)}</td>
                  <td
                    className={`numeric${pullRequest.cycleTimeSeconds === null ? ' absent' : ''}`}
                  >
                    {formatDuration(pullRequest.cycleTimeSeconds)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </main>
  );
}
