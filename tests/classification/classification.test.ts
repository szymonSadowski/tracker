/**
 * Work classification (spec: work-classification).
 *
 * The property under test throughout is containment: classification is versioned, cached,
 * bounded, correctable, and — above all — incapable of moving a deterministic number.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { databaseFixture } from '../helpers/db';
import {
  at,
  BASE_TIME,
  seedContributor,
  seedFile,
  seedPullRequest,
  seedRepository,
  seedUser,
  seedWorkspace,
} from '../helpers/factories';
import { workspaceScope } from '../../src/db/scope';
import { analyzePullRequest } from '../../src/analysis/service';
import { workMixSeries } from '../../src/analysis/series';
import {
  collectClassificationBatch,
  startClassificationBatch,
} from '../../src/classification/service';
import {
  classificationState,
  correctClassification,
  listEligible,
  saveClassificationSettings,
} from '../../src/classification/store';
import { contentHash, type ClassificationInput } from '../../src/classification/model';
import { pullRequestContent } from '../../src/classification/prompt';
import { interpretResult } from '../../src/classification/provider';
import type {
  ClassificationOutcome,
  ClassificationProvider,
  ClassificationRequest,
} from '../../src/classification/provider';

const db = databaseFixture();

/** A provider that records what it was asked and answers from a script. No network. */
class FakeProvider implements ClassificationProvider {
  submitted: ClassificationRequest[][] = [];
  batches = 0;
  endedAfter = 0;
  private polls = 0;

  constructor(private readonly answers: (customId: string) => ClassificationOutcome) {}

  async submit(requests: readonly ClassificationRequest[]) {
    this.submitted.push([...requests]);
    this.batches++;
    return { batchId: `batch-${this.batches}` };
  }

  async ended() {
    return this.polls++ >= this.endedAfter;
  }

  async results() {
    return this.submitted.at(-1)!.map((request) => this.answers(request.customId));
  }
}

const classifiedAs = (workType: string, confidence = 0.9) =>
  (customId: string): ClassificationOutcome => ({
    customId,
    status: 'classified',
    workType: workType as never,
    confidence,
    rationale: 'because',
  });

async function scenario(options: { enabled?: boolean } = {}) {
  const workspace = await seedWorkspace(db());
  const repository = await seedRepository(db(), workspace.id);
  const author = await seedContributor(db(), workspace.id, { login: 'ada' });
  await saveClassificationSettings(db(), workspace.id, { enabled: options.enabled ?? true });
  return { workspaceId: workspace.id, repositoryId: repository.id, author };
}

async function seedClassifiablePullRequest(
  workspaceId: string,
  repositoryId: string,
  authorContributorId: string,
  overrides: { title?: string; body?: string; mergedAt?: Date } = {},
) {
  const pr = await seedPullRequest(db(), {
    workspaceId,
    repositoryId,
    authorContributorId,
    title: overrides.title ?? 'Fix the rate limiter',
    body: overrides.body ?? 'Corrects an off-by-one in the token bucket.',
    mergedAt: overrides.mergedAt ?? at(4),
  });
  await seedFile(db(), {
    workspaceId,
    pullRequestId: pr.id,
    path: 'src/limiter.ts',
    additions: 4,
    deletions: 2,
  });
  await db().transaction((tx) => analyzePullRequest(tx, pr.id));
  return pr;
}

describe('the classification payload', () => {
  it('is built from stored data and contains no file contents', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    await seedClassifiablePullRequest(workspaceId, repositoryId, author.id);

    const [input] = await listEligible(db(), workspaceId);
    const payload = pullRequestContent(input!);

    expect(payload).toContain('Fix the rate limiter');
    expect(payload).toContain('src/limiter.ts');
    // Paths, counts, and prose only — no diff hunks, no source lines.
    expect(payload).not.toContain('function');
    expect(payload).not.toMatch(/^@@|^\+\+\+|^---$/m);
  });

  it('rejects a work type outside the fixed set rather than coercing it', () => {
    const outcome = interpretResult('pr-1', {
      type: 'performance',
      confidence: 0.99,
      rationale: 'x',
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.reason).toContain('outside the fixed set');
  });
});

describe('eligibility', () => {
  it('makes no provider call for an unchanged pull request at the current revision', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    await seedClassifiablePullRequest(workspaceId, repositoryId, author.id);
    const provider = new FakeProvider(classifiedAs('bug_fix'));

    await startClassificationBatch(db(), workspaceId, { provider });
    await collectClassificationBatch(db(), workspaceId, 'batch-1', { provider });
    const second = await startClassificationBatch(db(), workspaceId, { provider });

    expect(second.enqueued).toBe(0);
    expect(provider.batches).toBe(1);
  });

  it('makes a pull request eligible again when its description changes', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const pr = await seedClassifiablePullRequest(workspaceId, repositoryId, author.id);
    const provider = new FakeProvider(classifiedAs('bug_fix'));
    await startClassificationBatch(db(), workspaceId, { provider });
    await collectClassificationBatch(db(), workspaceId, 'batch-1', { provider });

    await db().query('UPDATE pull_requests SET body = $2 WHERE id = $1', [
      pr.id,
      'Actually adds a new limiter strategy.',
    ]);

    expect(await listEligible(db(), workspaceId)).toHaveLength(1);
  });

  it('hashes only the fields the classification reads', () => {
    const base: ClassificationInput = {
      pullRequestId: 'a',
      title: 'Add limiter',
      body: 'text',
      commitMessages: ['one'],
      changedPaths: ['b.ts', 'a.ts'],
      additions: 10,
      deletions: 2,
      changedFiles: 2,
    };

    // Path order is not part of the identity; line counts are not part of the hash at all.
    expect(contentHash({ ...base, changedPaths: ['a.ts', 'b.ts'] })).toBe(contentHash(base));
    expect(contentHash({ ...base, additions: 999 })).toBe(contentHash(base));
    expect(contentHash({ ...base, title: 'Other' })).not.toBe(contentHash(base));
  });
});

describe('failure and absence', () => {
  it('leaves pull requests unclassified and eligible when the provider is unavailable', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    await seedClassifiablePullRequest(workspaceId, repositoryId, author.id);
    const broken: ClassificationProvider = {
      submit: async () => {
        throw new Error('provider unreachable');
      },
      ended: async () => true,
      results: async () => [],
    };

    await expect(
      startClassificationBatch(db(), workspaceId, { provider: broken }),
    ).rejects.toThrow('provider unreachable');

    expect(await listEligible(db(), workspaceId)).toHaveLength(1);
    const { rows } = await db().query('SELECT * FROM pr_classifications');
    expect(rows).toHaveLength(0);
  });

  it('records a failure without assigning a fallback work type', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    await seedClassifiablePullRequest(workspaceId, repositoryId, author.id);
    const provider = new FakeProvider((customId) => ({
      customId,
      status: 'failed',
      reason: 'Model returned no structured output',
    }));

    await startClassificationBatch(db(), workspaceId, { provider });
    await collectClassificationBatch(db(), workspaceId, 'batch-1', { provider });

    const { rows } = await db().query<{ status: string; work_type: string | null }>(
      'SELECT status, work_type FROM pr_classifications',
    );
    expect(rows[0]).toEqual({ status: 'failed', work_type: null });
  });

  it('does nothing at all when classification is disabled for the workspace', async () => {
    const { workspaceId, repositoryId, author } = await scenario({ enabled: false });
    const pr = await seedClassifiablePullRequest(workspaceId, repositoryId, author.id);
    const before = await db().query('SELECT * FROM pr_analysis WHERE pull_request_id = $1', [
      pr.id,
    ]);
    const provider = new FakeProvider(classifiedAs('feature'));

    const outcome = await startClassificationBatch(db(), workspaceId, { provider });

    expect(outcome.enqueued).toBe(0);
    expect(provider.batches).toBe(0);
    // Every deterministic metric is exactly as it was.
    const after = await db().query('SELECT * FROM pr_analysis WHERE pull_request_id = $1', [pr.id]);
    expect(after.rows).toEqual(before.rows);
  });
});

describe('classification never alters a deterministic metric', () => {
  it('leaves cycle time, churn, and size unchanged when a work type is re-classified', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    await seedClassifiablePullRequest(workspaceId, repositoryId, author.id);
    const deterministic = () =>
      db().query(
        `SELECT cycle_time_seconds, new_code_lines, refactor_lines, rework_lines, additions,
                deletions, size_bucket
           FROM pr_analysis`,
      );

    const first = new FakeProvider(classifiedAs('bug_fix'));
    await startClassificationBatch(db(), workspaceId, { provider: first });
    await collectClassificationBatch(db(), workspaceId, 'batch-1', { provider: first });
    const before = await deterministic();

    // A new revision would re-run it; force eligibility the same way a prompt change would.
    await db().query("UPDATE pr_classifications SET classification_version = 'v0'");
    const second = new FakeProvider(classifiedAs('refactor'));
    await startClassificationBatch(db(), workspaceId, { provider: second });
    await collectClassificationBatch(db(), workspaceId, 'batch-1', { provider: second });

    const { rows } = await db().query<{ work_type: string }>(
      'SELECT work_type FROM pr_classifications',
    );
    expect(rows[0]!.work_type).toBe('refactor');
    expect((await deterministic()).rows).toEqual(before.rows);
  });
});

describe('bounds and corrections', () => {
  it('pauses rather than failing when the spend bound would be exceeded', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    await seedClassifiablePullRequest(workspaceId, repositoryId, author.id);
    await saveClassificationSettings(db(), workspaceId, {
      spendBoundCents: 0,
      spendConsumedCents: 0,
    });
    const provider = new FakeProvider(classifiedAs('feature'));

    const outcome = await startClassificationBatch(db(), workspaceId, { provider });

    expect(outcome.enqueued).toBe(0);
    expect(outcome.pausedReason).toContain('spend bound');
    expect(provider.batches).toBe(0);
    // The reason is visible to owners.
    expect((await classificationState(db(), workspaceId)).pausedReason).toContain('spend bound');
  });

  it('preserves an owner correction across a bulk re-run', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const pr = await seedClassifiablePullRequest(workspaceId, repositoryId, author.id);
    const owner = await seedUser(db(), { login: 'owner' });
    const provider = new FakeProvider(classifiedAs('chore'));
    await startClassificationBatch(db(), workspaceId, { provider });
    await collectClassificationBatch(db(), workspaceId, 'batch-1', { provider });

    await correctClassification(db(), workspaceId, pr.id, 'feature', owner.id);

    // A bulk re-run at a new revision must not reach it at all.
    await db().query("UPDATE pr_classifications SET classification_version = 'v0'");
    expect(await listEligible(db(), workspaceId)).toHaveLength(0);

    const { rows } = await db().query<{ work_type: string; human_corrected: boolean }>(
      'SELECT work_type, human_corrected FROM pr_classifications',
    );
    expect(rows[0]).toMatchObject({ work_type: 'feature', human_corrected: true });
  });
});

describe('mix-of-work ratios', () => {
  it('computes over the classified subset and reports the unclassified count', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const scope = workspaceScope(db(), workspaceId);
    const classified: string[] = [];
    for (const type of ['bug_fix', 'feature', 'feature', 'chore']) {
      const pr = await seedClassifiablePullRequest(workspaceId, repositoryId, author.id, {
        title: `${type} change`,
      });
      classified.push(pr.id);
      await db().query(
        `INSERT INTO pr_classifications
           (workspace_id, pull_request_id, status, work_type, confidence, content_hash,
            classification_version)
         VALUES ($1,$2,'classified',$3,0.9,$4,'v1')`,
        [workspaceId, pr.id, type, `hash-${pr.id}`],
      );
    }
    // Two more with no classification at all.
    await seedClassifiablePullRequest(workspaceId, repositoryId, author.id);
    await seedClassifiablePullRequest(workspaceId, repositoryId, author.id);

    const [bucket] = await workMixSeries(
      scope,
      { period: { start: BASE_TIME, end: at(24), label: 'a day' }, repositoryIds: [repositoryId] },
      { granularity: 'day' },
    );

    expect(bucket!.classified).toBe(4);
    expect(bucket!.unclassified).toBe(2);
    expect(bucket!.defectRatio).toBeCloseTo(0.25, 3);
    expect(bucket!.innovationRatio).toBeCloseTo(0.5, 3);
  });

  it('leaves both ratios absent when a bucket has nothing classified', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const scope = workspaceScope(db(), workspaceId);
    await seedClassifiablePullRequest(workspaceId, repositoryId, author.id);

    const [bucket] = await workMixSeries(
      scope,
      { period: { start: BASE_TIME, end: at(24), label: 'a day' }, repositoryIds: [repositoryId] },
      { granularity: 'day' },
    );

    expect(bucket!.classified).toBe(0);
    expect(bucket!.defectRatio).toBeNull();
    expect(bucket!.innovationRatio).toBeNull();
  });

  it('treats a below-threshold classification as unclassified for the ratios', async () => {
    const { workspaceId, repositoryId, author } = await scenario();
    const scope = workspaceScope(db(), workspaceId);
    const pr = await seedClassifiablePullRequest(workspaceId, repositoryId, author.id);
    await db().query(
      `INSERT INTO pr_classifications
         (workspace_id, pull_request_id, status, work_type, confidence, content_hash,
          classification_version)
       VALUES ($1,$2,'classified','bug_fix',0.2,'hash','v1')`,
      [workspaceId, pr.id],
    );

    const [bucket] = await workMixSeries(
      scope,
      { period: { start: BASE_TIME, end: at(24), label: 'a day' }, repositoryIds: [repositoryId] },
      { granularity: 'day', confidenceThreshold: 0.6 },
    );

    expect(bucket!.classified).toBe(0);
    expect(bucket!.unclassified).toBe(1);
    // It is still stored and still visible on the pull request itself.
    const stored = await db().query('SELECT confidence FROM pr_classifications');
    expect(stored.rows).toHaveLength(1);
  });
});

/**
 * design.md D6: the provider SDK is a worker-side dependency. The read surfaces and the metric
 * layer must keep working with it absent, and the way to guarantee that is for them never to
 * import it.
 */
describe('the provider dependency is confined to the worker', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
    });
  }

  it('is imported by no file under app/ or src/analysis/', () => {
    const offenders = [...sourceFiles('app'), ...sourceFiles('src/analysis')].filter((file) =>
      /@anthropic-ai\/sdk/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('is imported by exactly one module in the classification layer', () => {
    const importers = sourceFiles('src').filter((file) =>
      /from '@anthropic-ai\/sdk'/.test(readFileSync(file, 'utf8')),
    );
    expect(importers).toEqual(['src/classification/provider.ts']);
  });
});
