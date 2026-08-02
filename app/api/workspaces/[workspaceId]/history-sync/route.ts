import { NextResponse } from 'next/server';
import { db } from '@/db/client';
import { requireWorkspaceAccess } from '@/auth/current';
import { AccessDeniedError } from '@/auth/access';
import { requestHistorySync } from '@/ingest/history';
import { syncStatus } from '@/repositories/store';

/**
 * History sync (spec: github-data-sync "Members can request a history sync over a chosen range").
 * `{ from: null }` asks for all available history; a date asks for everything created since it.
 *
 * Repeated requests are accepted rather than rejected: a repository already walking reports
 * `already_running`, and one that already holds the range reports `already_covered`, so the caller
 * can say which without a second request.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params;
  try {
    await requireWorkspaceAccess(workspaceId);
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 });
  }

  const parsed = parseFrom(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const outcome = await requestHistorySync(db(), workspaceId, parsed.from);
  const status = await syncStatus(db(), workspaceId);
  return NextResponse.json({
    ...outcome,
    from: parsed.from?.toISOString() ?? null,
    coverageStart: status.coverageStart,
  });
}

/** `from` is optional and nullable — both absent and null mean "all available history". */
function parseFrom(body: unknown): { from: Date | null } | { error: string } {
  const raw = (body as { from?: unknown } | null)?.from;
  if (raw === undefined || raw === null) return { from: null };
  if (typeof raw !== 'string') return { error: '`from` must be an ISO date string or null' };
  const from = new Date(raw);
  if (Number.isNaN(from.getTime())) return { error: `\`from\` is not a date: ${raw}` };
  if (from.getTime() > Date.now()) {
    return { error: '`from` is in the future; history can only be requested backwards' };
  }
  return { from };
}
