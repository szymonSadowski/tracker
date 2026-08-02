/**
 * Fetches an installation's current shape from GitHub and hands it to the persistence layer.
 * Kept separate from `service.ts` so the lifecycle rules can be tested without any HTTP.
 */
import type { Database } from '../db/driver';
import { githubRequest } from '../github/http';
import { GitHubRestClient, type RestRepository } from '../github/rest';
import type { InstallationTokenProvider } from '../github/app-auth';
import type { RepositoryInput } from '../repositories/store';
import {
  reconcileRepositories,
  recordInstallation,
  type RecordInstallationResult,
  type ReconcileResult,
} from './service';

export interface GitHubInstallationDetails {
  id: number;
  account: { node_id: string; login: string; type: string };
  repository_selection: 'selected' | 'all';
}

export function toRepositoryInput(repository: RestRepository): RepositoryInput {
  return {
    nodeId: repository.node_id,
    githubRepoId: repository.id,
    ownerLogin: repository.owner.login,
    name: repository.name,
    isPrivate: repository.private,
    defaultBranch: repository.default_branch,
  };
}

export interface InstallationGateway {
  getInstallation(githubInstallationId: number): Promise<GitHubInstallationDetails>;
  listRepositories(githubInstallationId: number): Promise<RestRepository[]>;
}

/** The real gateway: App JWT for the installation record, installation token for its repos. */
export class GitHubInstallationGateway implements InstallationGateway {
  constructor(
    private readonly tokens: InstallationTokenProvider,
    private readonly apiBaseUrl: string,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async getInstallation(githubInstallationId: number): Promise<GitHubInstallationDetails> {
    const response = await githubRequest<GitHubInstallationDetails>({
      url: `${this.apiBaseUrl}/app/installations/${githubInstallationId}`,
      token: this.tokens.appJwt(),
      fetchImpl: this.fetchImpl,
    });
    return response.data;
  }

  async listRepositories(githubInstallationId: number): Promise<RestRepository[]> {
    const client = new GitHubRestClient({
      apiBaseUrl: this.apiBaseUrl,
      token: () => this.tokens.getToken(githubInstallationId),
      fetchImpl: this.fetchImpl,
    });
    return client.listInstallationRepositories();
  }
}

/** Handle the installation callback end to end. */
export async function ingestInstallation(
  database: Database,
  gateway: InstallationGateway,
  githubInstallationId: number,
  installedByUserId?: string | null,
): Promise<RecordInstallationResult> {
  const installation = await gateway.getInstallation(githubInstallationId);
  const repositories = await gateway.listRepositories(githubInstallationId);
  return recordInstallation(database, {
    githubInstallationId,
    account: {
      nodeId: installation.account.node_id,
      login: installation.account.login,
      type: installation.account.type === 'User' ? 'User' : 'Organization',
    },
    repositorySelection: installation.repository_selection,
    repositories: repositories.map(toRepositoryInput),
    installedByUserId,
  });
}

/** Re-read the selection from GitHub and apply any changes (added, removed, renamed). */
export async function refreshRepositorySelection(
  database: Database,
  gateway: InstallationGateway,
  workspaceId: string,
  githubInstallationId: number,
): Promise<ReconcileResult> {
  const repositories = await gateway.listRepositories(githubInstallationId);
  return reconcileRepositories(database, workspaceId, repositories.map(toRepositoryInput));
}
