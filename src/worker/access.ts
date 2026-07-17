import { Jwt } from 'hono/utils/jwt';

export type AccessEnv = {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  DEV_USER_EMAIL?: string;
  ENVIRONMENT: string;
};

export type AccessIdentity = { email: string; displayName: string };
export type IdentityResolver = (request: Request, env: AccessEnv) => Promise<AccessIdentity | null>;

const identity = (emailValue: unknown, nameValue?: unknown): AccessIdentity | null => {
  if (typeof emailValue !== 'string') return null;
  const email = emailValue.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const name = typeof nameValue === 'string' ? nameValue.trim() : '';
  return { email, displayName: (name || email.split('@')[0]).slice(0, 80) };
};

export const resolveAccessIdentity: IdentityResolver = async (request, env) => {
  if (env.ENVIRONMENT === 'local' && env.DEV_USER_EMAIL) return identity(env.DEV_USER_EMAIL);

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  const domain = env.ACCESS_TEAM_DOMAIN?.trim().toLowerCase();
  if (!token || !domain || !env.ACCESS_AUD || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain)) return null;

  try {
    const payload = await Jwt.verifyWithJwks(token, {
      jwks_uri: `https://${domain}/cdn-cgi/access/certs`,
      verification: { iss: `https://${domain}`, aud: env.ACCESS_AUD },
      allowedAlgorithms: ['RS256'],
    });
    return identity(payload.email, payload.name);
  } catch {
    return null;
  }
};
