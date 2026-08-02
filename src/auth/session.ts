/**
 * Sessions (spec: auth-and-access-control "Sessions expire and can be revoked").
 *
 * The cookie carries a random token; only its hash is stored, so a database copy cannot be
 * replayed as a login. Sessions expire after a bounded period of inactivity, which is refreshed
 * on use.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Queryable } from '../db/driver';
import { getUser, type UserRecord } from './users';

export const SESSION_COOKIE = 'tracker_session';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface SessionRecord {
  id: string;
  userId: string;
  githubToken: string | null;
  expiresAt: Date;
}

export interface AuthenticatedSession {
  session: SessionRecord;
  user: UserRecord;
}

export async function createSession(
  db: Queryable,
  input: { userId: string; githubToken?: string | null; inactivityMinutes: number },
): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + input.inactivityMinutes * 60_000);
  await db.query(
    'INSERT INTO sessions (id, user_id, github_token, expires_at) VALUES ($1, $2, $3, $4)',
    [hashToken(token), input.userId, input.githubToken ?? null, expiresAt],
  );
  return { token, expiresAt };
}

/**
 * Resolve a cookie value to its session and user, sliding the expiry forward. Returns undefined
 * for an unknown, revoked, or expired token — the caller cannot tell which.
 */
export async function resolveSession(
  db: Queryable,
  token: string | undefined,
  options: { inactivityMinutes: number },
): Promise<AuthenticatedSession | undefined> {
  if (!token) return undefined;
  const id = hashToken(token);
  const { rows } = await db.query<{
    id: string;
    user_id: string;
    github_token: string | null;
    expires_at: Date;
  }>(
    `UPDATE sessions
        SET last_seen_at = now(),
            expires_at = now() + make_interval(secs => $2::double precision)
      WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING id, user_id, github_token, expires_at`,
    [id, options.inactivityMinutes * 60],
  );
  const row = rows[0];
  if (!row) return undefined;

  const user = await getUser(db, row.user_id);
  if (!user) return undefined;
  return {
    session: {
      id: row.id,
      userId: row.user_id,
      githubToken: row.github_token,
      expiresAt: row.expires_at,
    },
    user,
  };
}

export async function revokeSession(db: Queryable, token: string): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = now(), github_token = NULL WHERE id = $1', [
    hashToken(token),
  ]);
}

export async function revokeAllSessionsForUser(db: Queryable, userId: string): Promise<void> {
  await db.query(
    'UPDATE sessions SET revoked_at = now(), github_token = NULL WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
}

/** Constant-time comparison for OAuth state, which is attacker-supplied on the way back. */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
