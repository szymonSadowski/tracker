/**
 * GitHub OAuth — the only sign-in method (spec: auth-and-access-control, design.md D8).
 */
import { randomBytes } from 'node:crypto';
import { githubRequest } from '../github/http';
import type { GitHubProfile } from './users';

export const OAUTH_STATE_COOKIE = 'tracker_oauth_state';
/** `read:user` identifies the person; repository visibility is resolved per repository. */
export const OAUTH_SCOPES = 'read:user';

export function newOAuthState(): string {
  return randomBytes(16).toString('base64url');
}

export function authorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state,
    scope: OAUTH_SCOPES,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export class OAuthDeclinedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthDeclinedError';
  }
}

export interface OAuthExchangeOptions {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}

/** Exchange the callback code for a user access token. */
export async function exchangeCode(options: OAuthExchangeOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: options.code,
      redirect_uri: options.redirectUri,
    }),
  });
  const payload = (await response.json()) as { access_token?: string; error?: string };
  if (!payload.access_token) {
    // A declined or expired authorization: no session, and no user record written.
    throw new OAuthDeclinedError(payload.error ?? 'GitHub did not return an access token');
  }
  return payload.access_token;
}

export async function fetchProfile(
  token: string,
  apiBaseUrl: string,
  fetchImpl?: typeof fetch,
): Promise<GitHubProfile> {
  const response = await githubRequest<{
    id: number;
    node_id: string;
    login: string;
    name: string | null;
    avatar_url: string | null;
    email: string | null;
  }>({ url: `${apiBaseUrl}/user`, token, fetchImpl });
  return {
    githubUserId: response.data.id,
    githubNodeId: response.data.node_id,
    login: response.data.login,
    name: response.data.name,
    avatarUrl: response.data.avatar_url,
    email: response.data.email,
  };
}
