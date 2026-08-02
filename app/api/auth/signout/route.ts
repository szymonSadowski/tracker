import { NextResponse } from 'next/server';
import { loadConfig } from '@/config/env';
import { db } from '@/db/client';
import { revokeSession, SESSION_COOKIE } from '@/auth/session';

/** Sign out: the session stops granting access to any workspace data. */
export async function POST(request: Request) {
  const config = loadConfig();
  const token = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);

  if (token) await revokeSession(db(), token);

  const response = NextResponse.redirect(`${config.auth.baseUrl}/signin`, { status: 303 });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
