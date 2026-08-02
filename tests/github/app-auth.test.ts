import { generateKeyPairSync, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAppJwt, InstallationTokenProvider } from '../../src/github/app-auth';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function decode(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

describe('GitHub App authentication', () => {
  it('signs a verifiable, short-lived App JWT', () => {
    const now = new Date('2026-05-01T12:00:00Z');
    const jwt = createAppJwt('12345', privateKey, now);
    const [header, payload, signature] = jwt.split('.');

    expect(decode(header!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decode(payload!) as { iss: string; iat: number; exp: number };
    expect(claims.iss).toBe('12345');
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);

    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
  });

  it('reuses a token until it nears expiry, then mints a fresh one', async () => {
    let minted = 0;
    let now = new Date('2026-05-01T12:00:00Z');
    const provider = new InstallationTokenProvider(
      { appId: '1', privateKey, apiBaseUrl: 'https://api.github.test' },
      {
        now: () => now,
        fetchImpl: (async () => {
          minted++;
          return new Response(
            JSON.stringify({
              token: `token-${minted}`,
              expires_at: new Date(now.getTime() + 3600_000).toISOString(),
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        }) as unknown as typeof fetch,
      },
    );

    expect(await provider.getToken(555)).toBe('token-1');
    now = new Date(now.getTime() + 30 * 60_000);
    expect(await provider.getToken(555)).toBe('token-1');
    expect(minted).toBe(1);

    // 30 seconds from expiry: refreshed before a long operation can be caught out by it.
    now = new Date(now.getTime() + 29.5 * 60_000);
    expect(await provider.getToken(555)).toBe('token-2');
    expect(minted).toBe(2);
  });

  it('mints again after a token is invalidated', async () => {
    let minted = 0;
    const provider = new InstallationTokenProvider(
      { appId: '1', privateKey, apiBaseUrl: 'https://api.github.test' },
      {
        fetchImpl: (async () => {
          minted++;
          return new Response(
            JSON.stringify({
              token: `token-${minted}`,
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        }) as unknown as typeof fetch,
      },
    );

    await provider.getToken(555);
    provider.invalidate(555);
    expect(await provider.getToken(555)).toBe('token-2');
  });
});
