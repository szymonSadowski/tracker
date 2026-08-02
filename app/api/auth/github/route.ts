import { NextResponse } from 'next/server';
import { loadConfig } from '@/config/env';
import { authorizeUrl, newOAuthState, OAUTH_STATE_COOKIE } from '@/auth/oauth';

/** Start the GitHub OAuth flow. */
export async function GET(request: Request) {
  const config = loadConfig();
  const state = newOAuthState();
  const returnTo = new URL(request.url).searchParams.get('returnTo') ?? '/dashboard';

  const response = NextResponse.redirect(
    authorizeUrl({
      clientId: config.github.clientId,
      redirectUri: `${config.auth.baseUrl}/api/auth/github/callback`,
      state,
    }),
  );
  response.cookies.set(OAUTH_STATE_COOKIE, `${state}:${returnTo}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.auth.baseUrl.startsWith('https'),
    path: '/',
    maxAge: 600,
  });
  return response;
}
