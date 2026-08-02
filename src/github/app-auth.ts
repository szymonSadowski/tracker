/**
 * GitHub App authentication (spec: github-app-installation "Installation credentials are obtained
 * and refreshed automatically").
 *
 * App JWTs are signed per request from the private key. Installation access tokens are minted on
 * demand and held in memory only — never written to the database — and are replaced before they
 * expire, so a long backfill does not fail halfway through on an expired token.
 */
import { createSign } from 'node:crypto';
import { githubRequest } from './http';

/** Refresh this long before the token actually expires. */
const REFRESH_MARGIN_MS = 60_000;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function createAppJwt(appId: string, privateKey: string, now: Date = new Date()): string {
  const issuedAt = Math.floor(now.getTime() / 1000) - 60; // tolerate clock skew
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 540, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${base64url(signer.sign(privateKey))}`;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
  repositorySelection?: 'all' | 'selected';
}

export interface AppCredentials {
  appId: string;
  privateKey: string;
  apiBaseUrl: string;
}

export interface TokenProviderOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * Mints and caches installation tokens for the life of the process. Callers ask for a token per
 * request rather than holding one, so refresh is invisible to them.
 */
export class InstallationTokenProvider {
  private readonly cache = new Map<number, InstallationToken>();

  constructor(
    private readonly credentials: AppCredentials,
    private readonly options: TokenProviderOptions = {},
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async getToken(githubInstallationId: number): Promise<string> {
    const cached = this.cache.get(githubInstallationId);
    if (cached && cached.expiresAt.getTime() - this.now().getTime() > REFRESH_MARGIN_MS) {
      return cached.token;
    }
    const minted = await this.mint(githubInstallationId);
    this.cache.set(githubInstallationId, minted);
    return minted.token;
  }

  async mint(githubInstallationId: number): Promise<InstallationToken> {
    const jwt = createAppJwt(this.credentials.appId, this.credentials.privateKey, this.now());
    const response = await githubRequest<{
      token: string;
      expires_at: string;
      repository_selection?: 'all' | 'selected';
    }>({
      method: 'POST',
      url: `${this.credentials.apiBaseUrl}/app/installations/${githubInstallationId}/access_tokens`,
      token: jwt,
      fetchImpl: this.options.fetchImpl,
    });
    return {
      token: response.data.token,
      expiresAt: new Date(response.data.expires_at),
      repositorySelection: response.data.repository_selection,
    };
  }

  /** Drop a cached token — used when GitHub rejects it mid-flight. */
  invalidate(githubInstallationId: number): void {
    this.cache.delete(githubInstallationId);
  }

  /** App-level requests (installation listing, repository listing for an installation). */
  appJwt(): string {
    return createAppJwt(this.credentials.appId, this.credentials.privateKey, this.now());
  }
}
