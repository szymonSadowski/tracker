import { NextResponse } from 'next/server';
import { loadConfig } from '@/config/env';
import { db } from '@/db/client';
import { exchangeCode, fetchProfile, OAUTH_STATE_COOKIE } from '@/auth/oauth';
import { createSession, safeEquals, SESSION_COOKIE } from '@/auth/session';
import { upsertUser } from '@/auth/users';

/**
 * OAuth callback. A declined or mismatched authorization creates no session and writes no user
 * record (spec: auth-and-access-control).
 */
export async function GET(request: Request) {
  const config = loadConfig();
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${OAUTH_STATE_COOKIE}=`))
    ?.slice(OAUTH_STATE_COOKIE.length + 1);

  const [expectedState, returnTo = '/dashboard'] = decodeURIComponent(cookie ?? '').split(':');

  if (!code || !state || !expectedState || !safeEquals(state, expectedState)) {
    // The reason never reaches the URL — it would tell an attacker which half failed — but it is
    // logged, because "declined" with no server-side detail is undiagnosable.
    console.warn('[auth] OAuth callback rejected', {
      hasCode: Boolean(code),
      hasState: Boolean(state),
      hasStateCookie: Boolean(expectedState),
      stateMatches: Boolean(state && expectedState && safeEquals(state, expectedState)),
      baseUrl: config.auth.baseUrl,
    });
    return NextResponse.redirect(`${config.auth.baseUrl}/signin?error=declined`);
  }

  try {
    const token = await exchangeCode({
      clientId: config.github.clientId,
      clientSecret: config.github.clientSecret,
      code,
      redirectUri: `${config.auth.baseUrl}/api/auth/github/callback`,
    });
    const profile = await fetchProfile(token, config.github.apiBaseUrl);
    const user = await upsertUser(db(), profile);
    const session = await createSession(db(), {
      userId: user.id,
      githubToken: token,
      inactivityMinutes: config.auth.sessionInactivityMinutes,
    });

    const response = NextResponse.redirect(`${config.auth.baseUrl}${returnTo}`);
    response.cookies.set(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.auth.baseUrl.startsWith('https'),
      path: '/',
      expires: session.expiresAt,
    });
    response.cookies.delete(OAUTH_STATE_COOKIE);
    return response;
  } catch (error) {
    console.warn('[auth] OAuth exchange failed', {
      reason: error instanceof Error ? error.message : String(error),
      baseUrl: config.auth.baseUrl,
      redirectUri: `${config.auth.baseUrl}/api/auth/github/callback`,
    });
    return NextResponse.redirect(`${config.auth.baseUrl}/signin?error=declined`);
  }
}
