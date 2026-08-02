import { NextResponse } from 'next/server';
import { loadConfig } from '@/config/env';
import { db } from '@/db/client';
import { requireWorkspaceAccess } from '@/auth/current';
import { AccessDeniedError } from '@/auth/access';
import { requestOnDemandSync } from '@/ingest/incremental';

/**
 * On-demand sync (spec: github-data-sync "Members can trigger a sync on demand"). Repeated
 * requests inside the debounce window enqueue nothing further.
 */
export async function POST(
  _request: Request,
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

  const config = loadConfig();
  const outcome = await requestOnDemandSync(
    db(),
    workspaceId,
    config.sync.onDemandSyncDebounceSeconds,
  );
  return NextResponse.json(outcome);
}
