import { describe, expect, it } from 'vitest';
import { realPostgresOnly, databaseFixture } from '../helpers/db';
import { seedWorkspace } from '../helpers/factories';
import {
  backoffSeconds,
  cancelPendingJobs,
  claimNextJob,
  countJobs,
  enqueue,
  getJob,
  reclaimStaleJobs,
} from '../../src/jobs/queue';
import { Worker } from '../../src/jobs/worker';
import { PermanentError, RetryableError } from '../../src/jobs/errors';
import { registerScheduledTasks, runDueScheduledTasks } from '../../src/jobs/scheduler';
import type { ScheduledTaskDefinition } from '../../src/jobs/scheduler';

const db = databaseFixture();

async function workspace() {
  return (await seedWorkspace(db())).id;
}

describe('job queue', () => {
  it('enqueues inside the caller’s transaction and rolls back with it', async () => {
    const workspaceId = await workspace();

    await expect(
      db().transaction(async (tx) => {
        await enqueue(tx, {
          workspaceId,
          type: 'pull_request.analyze',
          payload: { pullRequestId: '00000000-0000-0000-0000-000000000001' },
        });
        throw new Error('caller failed after enqueueing');
      }),
    ).rejects.toThrow('caller failed after enqueueing');

    expect(await countJobs(db(), { workspaceId })).toBe(0);
  });

  it('collapses redundant work while a job with the same dedupe key is outstanding', async () => {
    const workspaceId = await workspace();
    const first = await enqueue(db(), {
      workspaceId,
      type: 'repository.incremental_sync',
      payload: { repositoryId: 'repo-1' },
      dedupeKey: 'sync:repo-1',
    });
    const second = await enqueue(db(), {
      workspaceId,
      type: 'repository.incremental_sync',
      payload: { repositoryId: 'repo-1' },
      dedupeKey: 'sync:repo-1',
    });

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(await countJobs(db(), { workspaceId, state: 'pending' })).toBe(1);
  });

  it('hands each job to exactly one claimant', async () => {
    const workspaceId = await workspace();
    await enqueue(db(), {
      workspaceId,
      type: 'pull_request.analyze',
      payload: { pullRequestId: 'a' },
    });
    await enqueue(db(), {
      workspaceId,
      type: 'pull_request.analyze',
      payload: { pullRequestId: 'b' },
    });

    const one = await claimNextJob(db(), 'worker-1');
    const two = await claimNextJob(db(), 'worker-2');
    const three = await claimNextJob(db(), 'worker-3');

    expect(one?.id).toBeDefined();
    expect(two?.id).toBeDefined();
    expect(one!.id).not.toBe(two!.id);
    expect(three).toBeUndefined();
  });

  it.skipIf(realPostgresOnly())('does not double-process under simultaneous claims', async () => {
    const workspaceId = await workspace();
    for (let i = 0; i < 20; i++) {
      await enqueue(db(), {
        workspaceId,
        type: 'pull_request.analyze',
        payload: { pullRequestId: `pr-${i}` },
      });
    }

    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, worker) =>
        Promise.all(Array.from({ length: 5 }, () => claimNextJob(db(), `worker-${worker}`))),
      ),
    );

    const claimed = claims.flat().filter((job) => job !== undefined);
    expect(claimed).toHaveLength(20);
    expect(new Set(claimed.map((job) => job!.id)).size).toBe(20);
  });

  it('retries with growing backoff and then fails terminally', async () => {
    const workspaceId = await workspace();
    const job = (await enqueue(db(), {
      workspaceId,
      type: 'pull_request.analyze',
      payload: { pullRequestId: 'a' },
      maxAttempts: 3,
    }))!;

    const worker = new Worker(db(), {
      'pull_request.analyze': async () => {
        throw new Error('handler blew up');
      },
    });

    const first = await worker.runOnce();
    expect(first?.result).toBe('retrying');
    let stored = (await getJob(db(), job.id))!;
    expect(stored.state).toBe('pending');
    expect(stored.attempts).toBe(1);
    expect(stored.runAfter.getTime()).toBeGreaterThan(Date.now());
    expect(stored.lastError).toContain('handler blew up');

    // Backoff would otherwise make the remaining attempts wait; bring each one due.
    for (const expected of ['retrying', 'failed'] as const) {
      await db().query("UPDATE jobs SET run_after = now() - interval '1 minute' WHERE id = $1", [
        job.id,
      ]);
      const outcome = await worker.runOnce();
      expect(outcome?.result).toBe(expected);
    }

    stored = (await getJob(db(), job.id))!;
    expect(stored.state).toBe('failed');
    expect(stored.attempts).toBe(3);
    expect(backoffSeconds(1)).toBe(10);
    expect(backoffSeconds(2)).toBe(20);
    expect(backoffSeconds(3)).toBe(40);
    expect(backoffSeconds(20)).toBe(3600);
  });

  it('honours a retry-after signal instead of the default backoff', async () => {
    const workspaceId = await workspace();
    const job = (await enqueue(db(), {
      workspaceId,
      type: 'repository.backfill',
      payload: { repositoryId: 'r' },
    }))!;

    const worker = new Worker(db(), {
      'repository.backfill': async () => {
        throw new RetryableError('rate limited', 900);
      },
    });
    await worker.runOnce();

    const stored = (await getJob(db(), job.id))!;
    const waitSeconds = (stored.runAfter.getTime() - Date.now()) / 1000;
    expect(waitSeconds).toBeGreaterThan(600);
  });

  it('spends no further attempts on a permanent failure', async () => {
    const workspaceId = await workspace();
    const job = (await enqueue(db(), {
      workspaceId,
      type: 'repository.backfill',
      payload: { repositoryId: 'r' },
      maxAttempts: 5,
    }))!;

    const worker = new Worker(db(), {
      'repository.backfill': async () => {
        throw new PermanentError('repository is gone');
      },
    });
    const outcome = await worker.runOnce();

    expect(outcome?.result).toBe('failed');
    expect((await getJob(db(), job.id))!.state).toBe('failed');
  });

  it('survives a worker that dies holding a job', async () => {
    const workspaceId = await workspace();
    const job = (await enqueue(db(), {
      workspaceId,
      type: 'pull_request.analyze',
      payload: { pullRequestId: 'a' },
    }))!;

    // Worker A claims the job and never reports back.
    const claimed = await claimNextJob(db(), 'worker-a');
    expect(claimed?.id).toBe(job.id);
    expect(await claimNextJob(db(), 'worker-b')).toBeUndefined();

    const reclaimed = await reclaimStaleJobs(db(), 0);
    expect(reclaimed).toBe(1);

    let ran = 0;
    const workerB = new Worker(db(), {
      'pull_request.analyze': async () => {
        ran++;
      },
    });
    const outcome = await workerB.runOnce();

    expect(outcome?.result).toBe('succeeded');
    expect(ran).toBe(1);
    const stored = (await getJob(db(), job.id))!;
    expect(stored.state).toBe('succeeded');
    expect(stored.attempts).toBe(2);
  });

  it('fails a job whose type has no handler rather than looping on it', async () => {
    const workspaceId = await workspace();
    await enqueue(db(), {
      workspaceId,
      type: 'repository.reprocess',
      payload: { repositoryId: 'r' },
    });
    const outcome = await new Worker(db(), {}).runOnce();
    expect(outcome?.result).toBe('failed');
  });

  it('cancels pending work for a workspace', async () => {
    const workspaceId = await workspace();
    await enqueue(db(), {
      workspaceId,
      type: 'repository.backfill',
      payload: { repositoryId: 'r' },
    });
    const cancelled = await cancelPendingJobs(db(), workspaceId, 'installation removed');
    expect(cancelled).toBe(1);
    expect(await claimNextJob(db(), 'worker')).toBeUndefined();
  });
});

describe('scheduled trigger', () => {
  it('enqueues due work and does not fire again before the interval passes', async () => {
    const workspaceId = await workspace();
    let calls = 0;
    const task: ScheduledTaskDefinition = {
      name: 'test.task',
      intervalSeconds: 900,
      enqueue: async (tx) => {
        calls++;
        await enqueue(tx, {
          workspaceId,
          type: 'workspace.schedule_syncs',
          payload: {},
        });
        return 1;
      },
    };

    await registerScheduledTasks(db(), [task]);
    expect(await runDueScheduledTasks(db(), [task])).toEqual([{ name: 'test.task', enqueued: 1 }]);
    expect(await runDueScheduledTasks(db(), [task])).toEqual([]);
    expect(calls).toBe(1);
    expect(await countJobs(db(), { workspaceId, state: 'pending' })).toBe(1);
  });
});
