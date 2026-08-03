/**
 * The execution trigger (spec: job-execution "An execution trigger is authenticated and reports
 * its outcome").
 *
 * This is the only route that acts on behalf of no user, so the things worth asserting are that it
 * is closed by default, that it cannot be aimed at a target, and that it says what it did.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { databaseFixture } from '../helpers/db';
import { seedWorkspace } from '../helpers/factories';
import { GET, POST } from '../../app/api/jobs/drain/route';
import { countJobs, enqueue } from '../../src/jobs/queue';

const db = databaseFixture();

const SECRET = 'test-drain-secret';

function request(init: { secret?: string; body?: unknown } = {}) {
  return new Request('http://localhost:3000/api/jobs/drain', {
    method: 'POST',
    headers: init.secret ? { authorization: `Bearer ${init.secret}` } : {},
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

afterEach(() => {
  delete process.env.JOBS_DRAIN_SECRET;
  delete process.env.CRON_SECRET;
});

describe('the drain endpoint', () => {
  it('refuses an unauthenticated request and claims nothing', async () => {
    process.env.JOBS_DRAIN_SECRET = SECRET;
    const workspaceId = (await seedWorkspace(db())).id;
    await enqueue(db(), {
      workspaceId,
      type: 'pull_request.analyze',
      payload: { pullRequestId: '00000000-0000-0000-0000-000000000001' },
    });

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(await countJobs(db(), { workspaceId, state: 'pending' })).toBe(1);
  });

  it('refuses a request presenting the wrong secret', async () => {
    process.env.JOBS_DRAIN_SECRET = SECRET;

    expect((await POST(request({ secret: 'not-the-secret' }))).status).toBe(404);
    expect((await POST(request({ secret: '' }))).status).toBe(404);
  });

  it('is closed while no secret is configured, whatever the caller presents', async () => {
    expect((await POST(request({ secret: SECRET }))).status).toBe(404);
    expect((await POST(request())).status).toBe(404);
  });

  it('accepts the secret Vercel’s scheduler sends', async () => {
    process.env.CRON_SECRET = SECRET;

    const response = await GET(request({ secret: SECRET }));

    expect(response.status).toBe(200);
  });

  it('reports zero counts over an empty queue rather than failing', async () => {
    process.env.JOBS_DRAIN_SECRET = SECRET;

    const response = await POST(request({ secret: SECRET }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      claimed: 0,
      succeeded: 0,
      retried: 0,
      failed: 0,
      reclaimed: 0,
    });
  });

  it('ignores a caller-supplied target', async () => {
    process.env.JOBS_DRAIN_SECRET = SECRET;
    const mine = (await seedWorkspace(db())).id;
    const other = (await seedWorkspace(db())).id;
    for (const workspaceId of [mine, other]) {
      await enqueue(db(), {
        workspaceId,
        type: 'workspace.recompute_analysis',
        payload: {},
      });
    }

    // A selector would be the difference between "drain the queue" and "act on that workspace".
    const response = await POST(
      request({ secret: SECRET, body: { workspaceId: other, repositoryId: 'repo-1' } }),
    );

    expect(response.status).toBe(200);
    // Both were claimed: nothing in the body narrowed the pass to the named workspace.
    expect(await response.json()).toMatchObject({ claimed: 2 });
  });
});
