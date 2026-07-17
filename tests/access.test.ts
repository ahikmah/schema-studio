import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAccessIdentity } from '../src/worker/access';

const base64url = (value: string | ArrayBuffer) => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
};

const signedToken = async (payload: Record<string, unknown>) => {
  const keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-key' }));
  const body = base64url(JSON.stringify(payload));
  const unsigned = `${header}.${body}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(unsigned));
  const publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
  return { token: `${unsigned}.${base64url(signature)}`, publicKey: { ...publicKey, alg: 'RS256', kid: 'test-key' } };
};

afterEach(() => vi.unstubAllGlobals());

describe('Cloudflare Access identity', () => {
  it('accepts a fixed local identity only in local mode', async () => {
    const request = new Request('http://localhost/api/auth/me');

    await expect(resolveAccessIdentity(request, {
      ENVIRONMENT: 'local',
      DEV_USER_EMAIL: ' Ada@Example.com ',
    })).resolves.toEqual({ email: 'ada@example.com', displayName: 'ada' });
    await expect(resolveAccessIdentity(request, {
      ENVIRONMENT: 'production',
      DEV_USER_EMAIL: 'ada@example.com',
    })).resolves.toBeNull();
  });

  it('fails closed in production when the Access token is missing', async () => {
    await expect(resolveAccessIdentity(new Request('https://schema.example/api/auth/me'), {
      ENVIRONMENT: 'production',
      ACCESS_TEAM_DOMAIN: 'mybro.cloudflareaccess.com',
      ACCESS_AUD: 'schema-audience',
    })).resolves.toBeNull();
  });

  it('validates a signed RS256 token against the team JWKS', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token, publicKey } = await signedToken({
      iss: 'https://mybro.cloudflareaccess.com',
      aud: 'schema-audience',
      email: 'Ada@Example.com',
      name: 'Ada Lovelace',
      iat: now,
      exp: now + 60,
    });
    const fetchJwks = vi.fn(async () => Response.json({ keys: [publicKey] }));
    vi.stubGlobal('fetch', fetchJwks);

    const identity = await resolveAccessIdentity(new Request('https://schema.example/api/auth/me', {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    }), {
      ENVIRONMENT: 'production',
      ACCESS_TEAM_DOMAIN: 'mybro.cloudflareaccess.com',
      ACCESS_AUD: 'schema-audience',
    });

    expect(identity).toEqual({ email: 'ada@example.com', displayName: 'Ada Lovelace' });
    expect(fetchJwks).toHaveBeenCalledWith('https://mybro.cloudflareaccess.com/cdn-cgi/access/certs', undefined);
  });

  it('rejects a token issued for a different Access application', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { token, publicKey } = await signedToken({
      iss: 'https://mybro.cloudflareaccess.com',
      aud: 'another-application',
      email: 'ada@example.com',
      iat: now,
      exp: now + 60,
    });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ keys: [publicKey] })));

    await expect(resolveAccessIdentity(new Request('https://schema.example/api/auth/me', {
      headers: { 'Cf-Access-Jwt-Assertion': token },
    }), {
      ENVIRONMENT: 'production',
      ACCESS_TEAM_DOMAIN: 'mybro.cloudflareaccess.com',
      ACCESS_AUD: 'schema-audience',
    })).resolves.toBeNull();
  });
});
