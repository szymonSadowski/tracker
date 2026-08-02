import Link from 'next/link';
import { db } from '@/db/client';
import { workspaceScope } from '@/db/scope';
import { loadWorkspacePage } from '@/ui/page-access';
import {
  listPullRequests,
  periodOfDays,
  previousPeriod,
  teamMetrics,
  type MetricScope,
} from '@/analysis/aggregate';
import { contributorForUser } from '@/auth/users';
import { syncStatus } from '@/repositories/store';
import {
  Card,
  ColdStart,
  CoverageNotice,
  MetricCard,
  PeriodSelector,
  Section,
} from '@/ui/components';
import {
  formatCount,
  formatDate,
  formatDuration,
  PERIOD_OPTIONS,
  parsePeriodDays,
  trend,
  UNAVAILABLE,
} from '@/ui/format';

/**
 * The personal view: your own pull requests and metrics, compared with your own previous period.
 * It is a self view, not a position in a list (design.md D10).
 */
export default async function PersonalPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { workspaceId } = await params;
  const { period: periodParam } = await searchParams;
  const { access, session } = await loadWorkspacePage(workspaceId);
  const scope = workspaceScope(db(), workspaceId);

  const days = parsePeriodDays(periodParam);
  const period = periodOfDays(days);
  const contributor = await contributorForUser(db(), workspaceId, session.user);
  const status = await syncStatus(db(), workspaceId);
  const coverage = {
    periodStart: period.start,
    coverageStart: status.coverageStart,
    historySyncing: status.historySyncing,
    historySyncHref: access.role === 'owner' ? `/w/${workspaceId}/settings` : undefined,
  };

  if (!contributor) {
    return (
      <main>
        <h1>My work</h1>
        <PeriodSelector days={days} options={PERIOD_OPTIONS} basePath={`/w/${workspaceId}/me`} />
        <CoverageNotice {...coverage} />
        <ColdStart title="No activity recorded for your account yet">
          Nothing in the selected repositories has been authored or reviewed by {session.user.login}{' '}
          within the history we hold. Your work will appear here once it is ingested.
        </ColdStart>
      </main>
    );
  }

  const filter: MetricScope = {
    period,
    repositoryIds: access.visibleRepositoryIds,
    contributorId: contributor.id,
  };
  const current = await teamMetrics(scope, filter);
  const earlier = await teamMetrics(scope, { ...filter, period: previousPeriod(period) });
  const pullRequests = await listPullRequests(scope, filter, { limit: 50 });

  const mergedTrend = trend(current.mergedCount, earlier.mergedCount);
  const cycleTrend = trend(current.cycleTime.median, earlier.cycleTime.median);

  return (
    <main>
      <h1>My work</h1>
      <p className="muted">Signed in as {session.user.login}</p>
      <PeriodSelector days={days} options={PERIOD_OPTIONS} basePath={`/w/${workspaceId}/me`} />
      <CoverageNotice {...coverage} />

      <div className="cards">
        <Card
          label="Merged pull requests"
          value={formatCount(current.mergedCount)}
          note={mergedTrend.label}
        />
        <MetricCard label="Median cycle time" summary={current.cycleTime} format={formatDuration} />
        <Card label="Cycle time trend" value={cycleTrend.label} />
        <MetricCard
          label="Median time to first review"
          summary={current.timeToFirstReview}
          format={formatDuration}
        />
      </div>

      <Section
        title="Your pull requests"
        aside={
          <Link
            className="muted"
            href={`/w/${workspaceId}/pulls?period=${days}&author=${contributor.id}`}
          >
            Open in the pull request list
          </Link>
        }
      >
        {pullRequests.length === 0 ? (
          <p className="notice">
            You have no merged pull requests in this period. Work happens in different shapes at
            different times; this is a record, not a target.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Pull request</th>
                <th>Repository</th>
                <th>Merged</th>
                <th>Cycle time</th>
                <th>To first review</th>
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
                  <td className="numeric">{formatDate(pullRequest.mergedAt)}</td>
                  <td
                    className={`numeric${pullRequest.cycleTimeSeconds === null ? ' absent' : ''}`}
                  >
                    {formatDuration(pullRequest.cycleTimeSeconds)}
                  </td>
                  <td
                    className={`numeric${
                      pullRequest.timeToFirstReviewSeconds === null ? ' absent' : ''
                    }`}
                  >
                    {pullRequest.timeToFirstReviewSeconds === null
                      ? UNAVAILABLE
                      : formatDuration(pullRequest.timeToFirstReviewSeconds)}
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
