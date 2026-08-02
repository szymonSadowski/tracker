/**
 * Builds the GitHub clients for one workspace: an installation-scoped REST client, a GraphQL
 * client, and the rate limit tracker they both report into.
 */
import { loadConfig, type SyncConfig } from '../config/env';
import type { Queryable } from '../db/driver';
import { PermanentError } from '../jobs/errors';
import { findInstallationByWorkspace } from '../installations/store';
import { InstallationTokenProvider } from './app-auth';
import { GitHubGraphQLClient } from './graphql';
import { RateLimitTracker } from './rate-limit';
import { GitHubRestClient } from './rest';

export interface GitHubContext {
  rest: GitHubRestClient;
  graphql: GitHubGraphQLClient;
  rateLimit: RateLimitTracker;
  githubInstallationId: number;
  sync: SyncConfig;
}

let sharedTokenProvider: InstallationTokenProvider | undefined;

export function tokenProvider(): InstallationTokenProvider {
  if (!sharedTokenProvider) {
    const config = loadConfig();
    sharedTokenProvider = new InstallationTokenProvider({
      appId: config.github.appId,
      privateKey: config.github.privateKey,
      apiBaseUrl: config.github.apiBaseUrl,
    });
  }
  return sharedTokenProvider;
}

/** Test seam, and the hook uninstall uses to discard cached credentials. */
export function setTokenProvider(provider: InstallationTokenProvider | undefined): void {
  sharedTokenProvider = provider;
}

export async function gitHubContextForWorkspace(
  db: Queryable,
  workspaceId: string,
): Promise<GitHubContext> {
  const installation = await findInstallationByWorkspace(db, workspaceId);
  if (!installation) {
    throw new PermanentError(`Workspace ${workspaceId} has no installation`);
  }
  if (installation.status !== 'active') {
    throw new PermanentError(
      `Installation for workspace ${workspaceId} is ${installation.status}; not syncing`,
    );
  }

  const config = loadConfig();
  const rateLimit = new RateLimitTracker(config.sync.rateLimitSafetyThreshold);
  const token = () => tokenProvider().getToken(installation.githubInstallationId);

  return {
    rest: new GitHubRestClient({
      apiBaseUrl: config.github.apiBaseUrl,
      token,
      onRateLimit: rateLimit.observe,
    }),
    graphql: new GitHubGraphQLClient({
      graphqlUrl: config.github.graphqlUrl,
      token,
      onRateLimit: rateLimit.observe,
    }),
    rateLimit,
    githubInstallationId: installation.githubInstallationId,
    sync: config.sync,
  };
}
