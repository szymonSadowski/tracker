/**
 * Job execution, in both mechanisms (spec: job-execution).
 *
 * The interesting cases are the ones a resident worker gets for free and a bounded pass has to be
 * given deliberately: recovering work whose executor vanished, and firing due scheduled tasks. Both
 * fail silently when omitted, which is why they are asserted here rather than trusted.
 */
import { describe, expect, it } from 'vitest';
import { databaseFixture, realPostgresOnly } from '../helpers/db';
import { seedInstallation, seedWorkspace } from '../helpers/factories';
import { runDrain } from '../../src/jobs/drain';
import { countJobs, enqueue, getJob } from '../../src/jobs/queue';
import { defaultScheduledTasks, type ScheduledTaskDefinition } from '../../src/jobs/scheduler';
import type { HandlerRegistry } from '../../src/jobs/worker';
import { db as processDb, directDatabaseUrl, executionDb, setDatabase } from '../../src/db/client';

const db = databaseFixture();

const PR_ID = '00000000-0000-0000-0000-000000000001';

async function workspace() {
  return (await seedWorkspace(db())).id;
}

/** A workspace the periodic sync task will find: active workspace, active installation. */
async function syncableWorkspace() {
  const workspaceId = await workspace();
  await seedInstallation(db(), workspaceId, { status: 'active' });
  return workspaceId;
}

function analyzeHandler(onRun?: () => Promise<void> | void): HandlerRegistry {
  return {
    'pull_request.analyze': async () => {
      await onRun?.();
    },
  };
}

async function enqueueAnalysis(workspaceId: string, dedupeKey?: string) {
  return enqueue(db(), {
    workspaceId,
    type: 'pull_request.analyze',
    payload: { pullRequestId: PR_ID },
    dedupeKey,
  });
}

/** Put a claimed job beyond its lock timeout, as a killed executor would leave it. */
async function abandon(jobId: string, secondsAgo = 600) {
  await db().query(
    `UPDATE jobs
        SET state = 'running', locked_by = 'executor-that-vanished',
            locked_at = now() - make_interval(secs => $2::double precision)
      WHERE id = $1`,
    [jobId, secondsAgo],
  );
}

describe('job execution', () => {
  it('recovers a job whose executor vanished and runs it', async () => {
    const workspaceId = await workspace();
    const job = (await enqueueAnalysis(workspaceId))!;
    await abandon(job.id);

    const result = await runDrain(db(), analyzeHandler(), { staleLockSeconds: 300 });

    expect(result.reclaimed).toBe(1);
    expect(result.claimed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect((await getJob(db(), job.id))!.state).toBe('succeeded');
  });

  it('unwedges a subject whose deduplicated work was left running', async () => {
    const workspaceId = await workspace();
    const first = (await enqueueAnalysis(workspaceId, 'analyze:pr-1'))!;
    await abandon(first.id);

    // While it sits there, the dedupe key suppresses every later enqueue for the same subject.
    expect(await enqueueAnalysis(workspaceId, 'analyze:pr-1')).toBeUndefined();

    await runDrain(db(), analyzeHandler(), { staleLockSeconds: 300 });

    // Recovered and completed, so the subject accepts work again.
    expect(await enqueueAnalysis(workspaceId, 'analyze:pr-1')).toBeDefined();
  });

  it('fires due scheduled work with no scheduler process running', async () => {
    const workspaceId = await syncableWorkspace();

    const result = await runDrain(
      db(),
      { 'workspace.schedule_syncs': async () => {} },
      { scheduledTasks: defaultScheduledTasks() },
    );

    expect(result.scheduledTasksFired).toBe(1);
    // The task enqueued periodic sync work, and this same pass executed it.
    expect(result.claimed).toBe(1);
    expect(await countJobs(db(), { workspaceId, type: 'workspace.schedule_syncs' })).toBe(1);
  });

  it('registers scheduled tasks it has never seen, so a first pass is not a no-op', async () => {
    await syncableWorkspace();
    const before = await db().query('SELECT name FROM scheduled_tasks');
    expect(before.rows).toHaveLength(0);

    const result = await runDrain(db(), {}, { scheduledTasks: defaultScheduledTasks() });

    expect(result.scheduledTasksFired).toBe(1);
  });

  it('does not tick when the caller runs a separate scheduler', async () => {
    await syncableWorkspace();

    const result = await runDrain(db(), {});

    expect(result.scheduledTasksFired).toBe(0);
    expect(await countJobs(db(), { type: 'workspace.schedule_syncs' })).toBe(0);
  });

  it('fires a task at most once per interval however often it is evaluated', async () => {
    await syncableWorkspace();
    const tasks = defaultScheduledTasks();

    const first = await runDrain(db(), {}, { scheduledTasks: tasks });
    const second = await runDrain(db(), {}, { scheduledTasks: tasks });
    const third = await runDrain(db(), {}, { scheduledTasks: tasks });

    expect([first, second, third].map((r) => r.scheduledTasksFired)).toEqual([1, 0, 0]);
  });

  it('stops claiming when the budget is spent and leaves the rest runnable', async () => {
    const workspaceId = await workspace();
    for (let i = 0; i < 3; i++) await enqueueAnalysis(workspaceId);

    // The clock only moves when a job runs, so the first job is admitted and the second is not.
    let clock = 0;
    const result = await runDrain(
      db(),
      analyzeHandler(() => {
        clock += 5_000;
      }),
      { budgetMs: 1_000, reserveMs: 0, now: () => clock },
    );

    expect(result.claimed).toBe(1);
    expect(result.budgetExhausted).toBe(true);
    expect(await countJobs(db(), { workspaceId, state: 'pending' })).toBe(2);
  });

  it('never interrupts the job in flight when the budget runs out', async () => {
    const workspaceId = await workspace();
    await enqueueAnalysis(workspaceId);
    let completed = false;
    let clock = 0;

    const result = await runDrain(
      db(),
      analyzeHandler(() => {
        clock += 60_000;
        completed = true;
      }),
      { budgetMs: 1_000, reserveMs: 0, now: () => clock },
    );

    expect(completed).toBe(true);
    expect(result.succeeded).toBe(1);
  });

  it('stops between jobs when asked to, without abandoning the one it holds', async () => {
    const workspaceId = await workspace();
    for (let i = 0; i < 3; i++) await enqueueAnalysis(workspaceId);
    let stopping = false;

    const result = await runDrain(
      db(),
      analyzeHandler(() => {
        stopping = true;
      }),
      { shouldContinue: () => !stopping },
    );

    expect(result.claimed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(await countJobs(db(), { workspaceId, state: 'pending' })).toBe(2);
  });

  it('reports zero counts over an empty queue rather than failing', async () => {
    const result = await runDrain(db(), analyzeHandler());

    expect(result).toEqual({
      reclaimed: 0,
      scheduledTasksFired: 0,
      claimed: 0,
      succeeded: 0,
      retried: 0,
      failed: 0,
      budgetExhausted: false,
    });
  });

  it('counts a retryable failure as retried and leaves the job runnable later', async () => {
    const workspaceId = await workspace();
    const job = (await enqueueAnalysis(workspaceId))!;

    const result = await runDrain(db(), {
      'pull_request.analyze': async () => {
        throw new Error('GitHub said no');
      },
    });

    expect({ claimed: result.claimed, retried: result.retried, failed: result.failed }).toEqual({
      claimed: 1,
      retried: 1,
      failed: 0,
    });
    const after = (await getJob(db(), job.id))!;
    expect(after.state).toBe('pending');
    expect(after.runAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it('never runs one job in two concurrent passes', async () => {
    if (realPostgresOnly()) return;
    const workspaceId = await workspace();
    await enqueueAnalysis(workspaceId);
    let executions = 0;

    const slow = analyzeHandler(async () => {
      executions++;
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const [a, b] = await Promise.all([runDrain(db(), slow), runDrain(db(), slow)]);

    expect(executions).toBe(1);
    expect(a.claimed + b.claimed).toBe(1);
  });

  it('executes every job type either mechanism can, with no type reserved to one', async () => {
    // The registry is what both mechanisms dispatch through; neither filters it.
    const types: ScheduledTaskDefinition[] = defaultScheduledTasks();
    expect(types).not.toHaveLength(0);

    const workspaceId = await workspace();
    await enqueue(db(), {
      workspaceId,
      type: 'workspace.recompute_analysis',
      payload: {},
    });
    await enqueueAnalysis(workspaceId);

    const seen: string[] = [];
    const result = await runDrain(db(), {
      'pull_request.analyze': async (ctx) => {
        seen.push(ctx.job.type);
      },
      'workspace.recompute_analysis': async (ctx) => {
        seen.push(ctx.job.type);
      },
    });

    expect(result.claimed).toBe(2);
    expect(seen.sort()).toEqual(['pull_request.analyze', 'workspace.recompute_analysis']);
  });
});

describe('the execution database handle', () => {
  it('is the process handle when no direct connection is configured', () => {
    delete process.env.DATABASE_URL_DIRECT;
    delete process.env.DATABASE_URL_UNPOOLED;
    expect(executionDb()).toBe(processDb());
  });

  it('reads the name Vercel’s Neon integration provisions', () => {
    delete process.env.DATABASE_URL_DIRECT;
    process.env.DATABASE_URL_UNPOOLED = 'postgres://direct.example:5432/tracker';
    try {
      expect(directDatabaseUrl()).toBe('postgres://direct.example:5432/tracker');
    } finally {
      delete process.env.DATABASE_URL_UNPOOLED;
    }
  });

  it('prefers the explicit name over the integration’s', () => {
    process.env.DATABASE_URL_DIRECT = 'postgres://explicit.example:5432/tracker';
    process.env.DATABASE_URL_UNPOOLED = 'postgres://integration.example:5432/tracker';
    try {
      expect(directDatabaseUrl()).toBe('postgres://explicit.example:5432/tracker');
    } finally {
      delete process.env.DATABASE_URL_DIRECT;
      delete process.env.DATABASE_URL_UNPOOLED;
    }
  });

  it('still honours an installed test handle when a direct connection is configured', () => {
    process.env.DATABASE_URL_DIRECT = 'postgres://unreachable.invalid:5432/nope';
    try {
      expect(executionDb()).toBe(db());
    } finally {
      delete process.env.DATABASE_URL_DIRECT;
      setDatabase(db());
    }
  });
});
