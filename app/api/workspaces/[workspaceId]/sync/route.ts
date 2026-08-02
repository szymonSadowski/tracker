import { NextResponse } from 'next/server';
import { loadConfig } from '@/config/env';
import { db } from '@/db/client';
import { requireWorkspaceAccess } from '@/auth/current';
import { AccessDeniedError, assertRepositoryVisible } from '@/auth/access';
import { requestOnDemandSync } from '@/ingest/incremental';

/**
 * On-demand sync (spec: github-data-sync "Members can trigger a sync on demand"). Repeated
 * requests inside the debounce window enqueue nothing further.
 *
 * An optional `{ repositoryId }` narrows the request to one repository — what the pull request
 * list offers while it is filtered to a single one. A repository the caller cannot see on GitHub
 * is answered as "not found", exactly as the rest of the product does, so the endpoint cannot be
 * used to discover which repositories exist.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params;
  const repositoryId = await repositoryIdFrom(request);

  try {
    const { access } = await requireWorkspaceAccess(workspaceId);
    if (repositoryId) assertRepositoryVisible(access, repositoryId);
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
    { repositoryId },
  );
  return NextResponse.json(outcome);
}

/** The workspace-wide button posts no body at all, so an absent or unreadable one is not an error. */
async function repositoryIdFrom(request: Request): Promise<string | undefined> {
  try {
    const body = (await request.json()) as { repositoryId?: unknown } | null;
    return typeof body?.repositoryId === 'string' ? body.repositoryId : undefined;
  } catch {
    return undefined;
  }
}
