'use client';

import { useState } from 'react';

/**
 * Requests a history sync for the workspace (spec: "Members can request a history sync over a
 * chosen range"): all available history, or everything created since a chosen date.
 *
 * The per-repository outcome comes back with the request, so "already covered" and "already
 * running" are shown without a second round trip — neither is a failure.
 */
interface HistoryOutcome {
  enqueued: number;
  from: string | null;
  repositories: {
    repositoryId: string;
    fullName: string;
    status: 'enqueued' | 'already_covered' | 'already_running';
    coveredFrom: string | null;
    historyComplete: boolean;
  }[];
}

/** Today in the viewer's calendar, as the `yyyy-mm-dd` a date input expects. */
function localToday(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

const STATUS_LABEL: Record<HistoryOutcome['repositories'][number]['status'], string> = {
  enqueued: 'queued',
  already_covered: 'already covered',
  already_running: 'already running',
};

export function HistorySyncControl({ workspaceId }: { workspaceId: string }) {
  const [scope, setScope] = useState<'all' | 'since'>('all');
  const [since, setSince] = useState('');
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<HistoryOutcome | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function request() {
    setPending(true);
    setError(undefined);
    setOutcome(undefined);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/history-sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: scope === 'all' ? null : new Date(since).toISOString() }),
      });
      const body = (await response.json()) as HistoryOutcome & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `The request failed (${response.status})`);
      setOutcome(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  const invalid = scope === 'since' && (since === '' || Number.isNaN(new Date(since).getTime()));

  return (
    <div className="stack">
      <div className="inline-form">
        <label>
          <input
            type="radio"
            name="history-scope"
            checked={scope === 'all'}
            onChange={() => setScope('all')}
          />{' '}
          All available history
        </label>
        <label>
          <input
            type="radio"
            name="history-scope"
            checked={scope === 'since'}
            onChange={() => setScope('since')}
          />{' '}
          Since
        </label>
        <input
          type="date"
          value={since}
          // The picker works in the viewer's own calendar, so the ceiling must be their today.
          // A UTC date would be tomorrow or yesterday for anyone off the meridian — and for
          // anyone ahead of it, would refuse the date they are actually living in.
          max={localToday()}
          onChange={(event) => {
            setSince(event.target.value);
            setScope('since');
          }}
        />
        <button className="button" type="button" onClick={request} disabled={pending || invalid}>
          {pending ? 'Requesting…' : 'Sync history'}
        </button>
      </div>
      <p className="muted">
        Each repository is walked backwards from its newest pull request, so coverage reaches
        further back the longer it runs, and it runs behind ordinary syncing so current data stays
        fresh. A large organisation can take hours or days; progress is recorded as it goes, and
        leaving this page does not stop it.
      </p>
      {error ? <p className="notice notice-warn">{error}</p> : null}
      {outcome ? (
        <div className="notice">
          <p>
            {outcome.enqueued > 0
              ? `Requested history for ${outcome.enqueued} repositor${
                  outcome.enqueued === 1 ? 'y' : 'ies'
                }.`
              : 'Nothing new to fetch for this range.'}
          </p>
          <ul>
            {outcome.repositories.map((repository) => (
              <li key={repository.repositoryId}>
                {repository.fullName} — {STATUS_LABEL[repository.status]}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
