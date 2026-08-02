/** Shared presentation pieces for the read surfaces (spec: analytics-dashboard). */
import Link from 'next/link';
import type { ReactNode } from 'react';
import { coverageNote, formatDate, relativeTime, UNAVAILABLE } from './format';
import type { MetricSummary } from '../analysis/aggregate';

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

export interface CompletenessProps {
  backfilling: { id: string; fullName: string }[];
  failing: { fullName: string; lastError: string | null; consecutiveFailures: number }[];
  lastSuccessAt: Date | null;
  isOwner: boolean;
}

/** Says plainly when the data behind a surface is incomplete or stale. */
export function DataCompleteness({
  backfilling,
  failing,
  lastSuccessAt,
  isOwner,
}: CompletenessProps) {
  return (
    <div className="completeness">
      {backfilling.length > 0 ? (
        <p className="notice">
          Historical data is still loading for {backfilling.map((r) => r.fullName).join(', ')}.
          Numbers below will change as it arrives.
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
