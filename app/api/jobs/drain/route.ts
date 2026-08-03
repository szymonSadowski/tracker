import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { jobDefaults } from '@/config/env';
import { executionDb } from '@/db/client';
import { runDrain } from '@/jobs/drain';
import { handlers } from '@/jobs/handlers/index';
import { defaultScheduledTasks } from '@/jobs/scheduler';

/**
 * The execution trigger (spec: job-execution "An execution trigger is authenticated and reports
 * its outcome", design D6).
 *
 * This is the one route that acts on behalf of no user, which is why it is authenticated by a
 * shared secret rather than by a session, and why it accepts nothing from its caller. A request
 * body naming a workspace, repository, or job would turn it into a way to make the server act on a
 * chosen target with no identity attached; there is no such parameter, and the body is never read.
 *
 * What runs, and in what order, is `runDrain`'s decision — recovery and the scheduled-task tick are
 * not this route's to skip.
 */
export const dynamic = 'force-dynamic';

/** Kept under the platform's function ceiling; the drain's own reserve keeps a pass inside it. */
export const maxDuration = 300;

function secretMatches(presented: string, expected: string): boolean {
  // Hashing first gives both sides a fixed, equal length, so the comparison cannot leak the
  // secret's length and `timingSafeEqual` cannot throw on a mismatched one.
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function authorized(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return false;
  return secretMatches(header.slice('Bearer '.length), expected);
}

async function drain(request: Request) {
  const jobs = jobDefaults();
  if (!authorized(request, jobs.drainSecret)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const result = await runDrain(executionDb(), handlers, {
    budgetMs: jobs.drainBudgetMs,
    reserveMs: jobs.drainReserveMs,
    scheduledTasks: defaultScheduledTasks(),
    log: (message, fields) => console.log(JSON.stringify({ message, ...fields })),
  });

  return NextResponse.json(result);
}

export async function POST(request: Request) {
  return drain(request);
}

/** Vercel's scheduler issues GET; the endpoint is not otherwise reachable without the secret. */
export async function GET(request: Request) {
  return drain(request);
}
