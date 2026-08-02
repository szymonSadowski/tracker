/** Shared presentation pieces for the read surfaces (spec: analytics-dashboard). */
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  coverageLabel,
  coverageNote,
  formatDate,
  formatDay,
  relativeTime,
  UNAVAILABLE,
} from './format';
import type { MetricSummary } from '../analysis/aggregate';
import type { HistoryState } from '../repositories/store';

export function Card({
  label,
  value,
  note,
  href,
}: {
  label: string;
  value: string;
  note?: string;
  href?: string;
}) {
  const body = (
    <>
      <span className="card-label">{label}</span>
      <span className={`card-value${value === UNAVAILABLE ? ' card-value-absent' : ''}`}>
        {value}
      </span>
      {note ? <span className="card-note">{note}</span> : null}
    </>
  );
  return href ? (
    <Link className="card card-link" href={href}>
      {body}
    </Link>
  ) : (
    <div className="card">{body}</div>
  );
}

/** A latency card: the median, and how many pull requests it was computed from. */
export function MetricCard({
  label,
  summary,
  format,
  href,
}: {
  label: string;
  summary: MetricSummary;
  format: (value: number | null) => string;
  href?: string;
}) {
  return (
    <Card
      label={label}
      value={format(summary.median)}
      note={coverageNote(summary.covered, summary.total)}
      href={href}
    />
  );
}

export function SizeDistribution({ distribution }: { distribution: Record<string, number> }) {
  const total = Object.values(distribution).reduce((sum, count) => sum + count, 0);
  const labels: Record<string, string> = {
    xs: 'XS (<10 lines)',
    s: 'S (<50)',
    m: 'M (<250)',
    l: 'L (<1000)',
    xl: 'XL (1000+)',
  };
  if (total === 0) {
    return <p className="muted">No merged pull requests in this period.</p>;
  }
  return (
    <ul className="distribution">
      {Object.entries(distribution).map(([bucket, count]) => (
        <li key={bucket}>
          <span className="distribution-label">{labels[bucket] ?? bucket}</span>
          <span className="distribution-bar">
            <span style={{ width: `${total === 0 ? 0 : (count / total) * 100}%` }} />
          </span>
          <span className="distribution-count">{count}</span>
        </li>
      ))}
    </ul>
  );
}

export function PeriodSelector({
  days,
  options,
  basePath,
  extraQuery = '',
}: {
  days: number;
  options: readonly number[];
  basePath: string;
  extraQuery?: string;
}) {
  return (
    <div className="period">
      <span className="muted">Period:</span>
      {options.map((option) => (
        <Link
          key={option}
          className={option === days ? 'chip chip-active' : 'chip'}
          href={`${basePath}?period=${option}${extraQuery}`}
        >
          {option} days
        </Link>
      ))}
      <span className="period-label">Showing the last {days} days</span>
    </div>
  );
}

export interface CoverageDisplay {
  coveredFrom: Date | null;
  historyComplete: boolean;
  historyState: HistoryState;
  historyError?: string | null;
}

/**
 * How far back one repository's data reaches, and what an outstanding history request is doing
 * with it (spec: "History sync progress is observable"). A rate limit pause is worded as a pause,
 * not as a failure: it resumes on its own and nothing is lost.
 */
export function CoverageState({ coverage }: { coverage: CoverageDisplay }) {
  const note = {
    idle: null,
    complete: null,
    running: 'history sync running',
    paused: 'history sync paused for rate limits — it resumes on its own',
    failed: `history sync failed${coverage.historyError ? `: ${coverage.historyError}` : ''}`,
  }[coverage.historyState];
  return (
    <>
      <span>{coverageLabel(coverage.coveredFrom, coverage.historyComplete)}</span>
      {note ? (
        <span className={coverage.historyState === 'failed' ? '' : 'muted'}> · {note}</span>
      ) : null}
    </>
  );
}

export interface HistorySyncProgress {
  id: string;
  fullName: string;
  coveredFrom: Date | null;
  paused: boolean;
}

/**
 * Says that a period reaches back further than the data does, so an empty stretch is not read as
 * a quiet one (spec: analytics-dashboard "A viewer selects a period reaching before synced
 * coverage"). Renders nothing when the period sits entirely inside coverage — a covered period
 * with no pull requests is genuinely empty, and saying otherwise would be a lie in the other
 * direction.
 */
export function CoverageNotice({
  periodStart,
  coverageStart,
  historySyncing = [],
  historySyncHref,
}: {
  periodStart: Date;
  coverageStart: Date | null;
  historySyncing?: HistorySyncProgress[];
  historySyncHref?: string;
}) {
  if (coverageStart === null || periodStart >= coverageStart) return null;
  return (
    <p className="notice">
      This period begins before the data does. Pull requests are present from{' '}
      {formatDay(coverageStart)} onwards; anything earlier is missing rather than absent.{' '}
      {historySyncing.length > 0 ? (
        <>A history sync is already extending it.</>
      ) : historySyncHref ? (
        <Link href={historySyncHref}>Sync older history</Link>
      ) : (
        <>An owner can sync older history from settings.</>
      )}
    </p>
  );
}

export interface CompletenessProps {
  backfilling: { id: string; fullName: string }[];
  failing: { fullName: string; lastError: string | null; consecutiveFailures: number }[];
  lastSuccessAt: Date | null;
  isOwner: boolean;
  historySyncing?: HistorySyncProgress[];
}

/** Says plainly when the data behind a surface is incomplete or stale. */
export function DataCompleteness({
  backfilling,
  failing,
  lastSuccessAt,
  isOwner,
  historySyncing = [],
}: CompletenessProps) {
  return (
    <div className="completeness">
      {backfilling.length > 0 ? (
        <p className="notice">
          Historical data is still loading for {backfilling.map((r) => r.fullName).join(', ')}.
          Numbers below will change as it arrives.
        </p>
      ) : null}
      {historySyncing.length > 0 ? (
        // Older data is still arriving, but everything already inside coverage is complete — so
        // this states what is happening without suppressing the metrics (spec: "A history sync is
        // running").
        <p className="notice">
          Older pull requests are still being added for{' '}
          {historySyncing
            .map(
              (repository) =>
                `${repository.fullName} (${
                  repository.paused ? 'paused for rate limits, ' : ''
                }reaching back to ${formatDay(repository.coveredFrom)})`,
            )
            .join(', ')}
          . Metrics for periods already covered are unaffected.
        </p>
      ) : null}
      {failing.length > 0 ? (
        <p className="notice notice-warn">
          Data may be stale: {failing.length} repository{failing.length === 1 ? '' : 'ies'} failed
          to sync. Last successful sync {relativeTime(lastSuccessAt)}
          {lastSuccessAt ? ` (${formatDate(lastSuccessAt)})` : ''}.
          {isOwner && failing[0]?.lastError ? ` Reason: ${failing[0].lastError}` : ''}
        </p>
      ) : (
        <p className="muted">Last synced {relativeTime(lastSuccessAt)}.</p>
      )}
    </div>
  );
}

/** A cold-start state: the specific missing prerequisite, and the action that resolves it. */
export function ColdStart({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: { href: string; label: string };
}) {
  return (
    <div className="coldstart">
      <h2>{title}</h2>
      <p>{children}</p>
      {action ? (
        <Link className="button" href={action.href}>
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

export function Section({
  title,
  children,
  aside,
}: {
  title: string;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="section">
      <div className="section-head">
        <h2>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
