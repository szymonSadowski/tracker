/** Presentation helpers. Absent values render as "unavailable", never as zero (design.md D6). */

export const UNAVAILABLE = 'Not available';

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return UNAVAILABLE;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  if (hours < 48) {
    const wholeHours = Math.floor(hours);
    const remainder = Math.round((hours - wholeHours) * 60);
    return remainder > 0 ? `${wholeHours}h ${remainder}m` : `${wholeHours}h`;
  }
  const days = hours / 24;
  return days < 10 ? `${days.toFixed(1)}d` : `${Math.round(days)}d`;
}

export function formatCount(value: number | null | undefined): string {
  return value === null || value === undefined ? UNAVAILABLE : value.toLocaleString('en-GB');
}

export function formatNumber(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined ? UNAVAILABLE : value.toFixed(digits);
}

export function formatDate(value: Date | null | undefined): string {
  if (!value) return UNAVAILABLE;
  return value.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function relativeTime(value: Date | null | undefined, now: Date = new Date()): string {
  if (!value) return 'never';
  const seconds = Math.round((now.getTime() - value.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

/** "covers 12 of 30 pull requests" — an aggregate always reports its own coverage. */
export function coverageNote(covered: number, total: number, noun = 'pull requests'): string {
  if (total === 0) return `no ${noun} in this period`;
  if (covered === total) return `covers all ${total} ${noun}`;
  return `covers ${covered} of ${total} ${noun}`;
}

/** A change against one's own previous period — never against another person. */
export function trend(
  current: number | null,
  previous: number | null,
): { label: string; direction: 'up' | 'down' | 'flat' | 'unknown' } {
  if (current === null || previous === null || previous === 0) {
    return { label: 'no comparison available', direction: 'unknown' };
  }
  const delta = ((current - previous) / previous) * 100;
  if (Math.abs(delta) < 5) return { label: 'about the same as last period', direction: 'flat' };
  return {
    label: `${Math.abs(Math.round(delta))}% ${delta > 0 ? 'higher' : 'lower'} than last period`,
    direction: delta > 0 ? 'up' : 'down',
  };
}

export const PERIOD_OPTIONS = [7, 30, 90] as const;

export function parsePeriodDays(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return PERIOD_OPTIONS.includes(parsed as (typeof PERIOD_OPTIONS)[number]) ? parsed : 30;
}
