'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Refreshes one repository from the pull request list, while it is filtered to that repository.
 *
 * Same endpoint and same debounce as the workspace-wide button in settings, narrowed to one
 * repository — including the debounce, so a workspace sync a moment ago does not silence this.
 */
interface SyncOutcome {
  enqueued: number;
  debounced: boolean;
  backfilling: { id: string; fullName: string }[];
}

export function SyncRepositoryButton({
  workspaceId,
  repositoryId,
  repositoryName,
}: {
  workspaceId: string;
  repositoryId: string;
  repositoryName: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);

  async function trigger() {
    setPending(true);
    setMessage(undefined);
    setFailed(false);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repositoryId }),
      });
      if (!response.ok) throw new Error(`The request failed (${response.status})`);
      const outcome = (await response.json()) as SyncOutcome;
      setMessage(describe(outcome, repositoryName));
      // The sync runs in the worker, so nothing has arrived yet; refresh the list so a second
      // look does not need a manual reload once it has.
      if (outcome.enqueued > 0) router.refresh();
    } catch (cause) {
      setFailed(true);
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        className="button button-secondary"
        type="button"
        onClick={trigger}
        disabled={pending}
      >
        {pending ? 'Requesting…' : `Sync ${repositoryName}`}
      </button>
      {message ? <span className={failed ? '' : 'muted'}>{message}</span> : null}
    </>
  );
}

function describe(outcome: SyncOutcome, repositoryName: string): string {
  if (outcome.backfilling.length > 0) {
    return `${repositoryName} is still loading its history; nothing new was queued.`;
  }
  if (outcome.debounced) return `${repositoryName} was synced moments ago.`;
  if (outcome.enqueued === 0) return `${repositoryName} is already queued to sync.`;
  return `Syncing ${repositoryName} now — refresh in a moment.`;
}
