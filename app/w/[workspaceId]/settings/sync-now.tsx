'use client';

import { useState } from 'react';

/**
 * Triggers the on-demand sync endpoint that already exists (design.md D7).
 *
 * The debounced case is rendered rather than swallowed: a request inside the rate limiting
 * interval is a legitimate outcome to report, and hiding it makes the button look dead
 * (spec: "Member triggers a sync inside the rate limiting interval").
 */
interface SyncOutcome {
  enqueued: number;
  debounced: boolean;
  backfilling: { id: string; fullName: string }[];
}

export function SyncNowButton({ workspaceId }: { workspaceId: string }) {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<SyncOutcome | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function trigger() {
    setPending(true);
    setError(undefined);
    setOutcome(undefined);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/sync`, { method: 'POST' });
      if (!response.ok) throw new Error(`The request failed (${response.status})`);
      setOutcome((await response.json()) as SyncOutcome);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="request-row">
      <h3>Recent changes</h3>
      <p className="muted">
        Fetches what has changed since the last sync, across every repository in scope. It
        completes promptly.
      </p>
      <div className="inline-form">
        <button className="button" type="button" onClick={trigger} disabled={pending}>
          {pending ? 'Requesting…' : 'Sync recent'}
        </button>
      </div>
      {error ? <p className="notice notice-warn">{error}</p> : null}
      {outcome ? <p className="notice">{describe(outcome)}</p> : null}
    </div>
  );
}

function describe(outcome: SyncOutcome): string {
  const skipped =
    outcome.backfilling.length > 0
      ? ` ${outcome.backfilling.map((r) => r.fullName).join(', ')} ${
          outcome.backfilling.length === 1 ? 'was' : 'were'
        } skipped — their history is still loading.`
      : '';
  if (outcome.debounced) {
    return `Already covered by a sync moments ago, so nothing new was queued.${skipped}`;
  }
  if (outcome.enqueued === 0) {
    return `No repository was ready to sync.${skipped}`;
  }
  return `Syncing ${outcome.enqueued} repositor${outcome.enqueued === 1 ? 'y' : 'ies'} now.${skipped}`;
}
