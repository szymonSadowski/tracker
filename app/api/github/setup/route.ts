import { NextResponse } from 'next/server';
import { loadConfig } from '@/config/env';
import { db } from '@/db/client';
import { currentSession } from '@/auth/current';
import { tokenProvider } from '@/github/context';
import { GitHubInstallationGateway, ingestInstallation } from '@/installations/github-sync';

/**
 * The GitHub App setup URL. GitHub redirects here after an installation is created or its
 * repository selection is changed; the installation, its repositories, and the installing user's
 * ownership are recorded, and a backfill is enqueued per repository entering scope.
 */
export async function GET(request: Request) {
  const config = loadConfig();
  const url = new URL(request.url);
  const installationId = Number(url.searchParams.get('installation_id'));
  const setupAction = url.searchParams.get('setup_action');

  if (!Number.isFinite(installationId) || installationId <= 0) {
    return NextResponse.redirect(`${config.auth.baseUrl}/dashboard?error=missing_installation`);
  }

  const session = await currentSession();
  if (!session) {
    // Sign in first, then come back here with the same parameters.
    const returnTo = encodeURIComponent(`/api/github/setup${url.search}`);
    return NextResponse.redirect(`${config.auth.baseUrl}/api/auth/github?returnTo=${returnTo}`);
  }

  const gateway = new GitHubInstallationGateway(tokenProvider(), config.github.apiBaseUrl);
  const result = await ingestInstallation(db(), gateway, installationId, session.user.id);

  const destination =
    setupAction === 'update'
      ? `/w/${result.workspaceId}/settings?updated=1`
      : `/w/${result.workspaceId}?installed=1`;
  return NextResponse.redirect(`${config.auth.baseUrl}${destination}`);
}
