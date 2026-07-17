import { Hono } from 'hono';
import type { PublicUser } from '../shared/types';
import { resolveAccessIdentity, type AccessEnv, type IdentityResolver } from './access';
import { openPostgres, type Database, type DatabaseFactory, type HyperdriveBinding } from './db';
import { registerProjectRoutes } from './projects';

export interface Env extends AccessEnv {
  HYPERDRIVE: HyperdriveBinding;
  ASSETS?: Fetcher;
}

export type AppBindings = { Bindings: Env; Variables: { db: Database } };
type UserRow = { id: string; email: string; display_name: string };

const jsonError = (error: string, status: 400 | 401 | 404 | 409 | 413 | 422 | 500) =>
  Response.json({ error }, { status });

const publicUser = (row: UserRow): PublicUser => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
});

export function createApp(databaseFactory: DatabaseFactory = openPostgres, identityResolver: IdentityResolver = resolveAccessIdentity) {
  const app = new Hono<AppBindings>();

  const currentUser = async (request: Request, env: Env, db: Database) => {
    const identity = await identityResolver(request, env);
    if (!identity) return null;
    const existing = (await db.query<UserRow>('SELECT id, email, display_name FROM users WHERE email = $1', [identity.email])).rows[0];
    if (existing) return existing;
    const now = new Date();
    return (await db.query<UserRow>(`INSERT INTO users (id, email, display_name, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $4)
      ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
      RETURNING id, email, display_name`, [crypto.randomUUID(), identity.email, identity.displayName, now])).rows[0];
  };

  app.use('/api/*', async (context, next) => {
    const method = context.req.method;
    const origin = context.req.header('origin');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && origin && origin !== new URL(context.req.url).origin) {
      return context.json({ error: 'Cross-origin request blocked' }, 403);
    }
    await next();
    context.header('Cache-Control', 'no-store');
    context.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('X-Frame-Options', 'DENY');
    context.header('Referrer-Policy', 'no-referrer');
  });

  app.use('/api/*', async (context, next) => {
    const db = await databaseFactory(context.env);
    context.set('db', db);
    try { await next(); } finally { await db.close(); }
  });

  app.get('/api/auth/me', async (context) => {
    const user = await currentUser(context.req.raw, context.env, context.var.db);
    return user ? context.json({ user: publicUser(user) }) : context.json({ error: 'Authentication required' }, 401);
  });

  registerProjectRoutes(app, currentUser);

  app.notFound((context) => context.req.path.startsWith('/api/')
    ? context.json({ error: 'Not found' }, 404)
    : context.env.ASSETS?.fetch(context.req.raw) ?? jsonError('Not found', 404));

  app.onError(() => jsonError('Unexpected server error', 500));
  return app;
}

const app = createApp();
export default app;
