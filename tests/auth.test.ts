import { describe, expect, it } from 'vitest';
import type { IdentityResolver } from '../src/worker/access';
import { createApp, type Env } from '../src/worker/index';
import { postgresTestDatabase } from './postgres-test';

const env = { ENVIRONMENT: 'test' } as Env;
const identity: IdentityResolver = async (request) => {
  const email = request.headers.get('x-test-user');
  return email ? { email, displayName: email.split('@')[0] } : null;
};

describe('Cloudflare Access authentication API', () => {
  it('opens and closes the injected PostgreSQL database for API requests', async () => {
    let closed = false;
    const app = createApp(async () => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      close: async () => { closed = true; },
    }), async () => null);

    const response = await app.request('/api/auth/me', {}, env);

    expect(response.status).toBe(401);
    expect(closed).toBe(true);
  });

  it('fails closed when no verified identity is available', async () => {
    const database = await postgresTestDatabase();
    const response = await createApp(database.factory, async () => null).request('/api/auth/me', {}, env);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Authentication required' });
    await database.close();
  });

  it('provisions one database user for repeated requests from the same identity', async () => {
    const database = await postgresTestDatabase();
    const app = createApp(database.factory, identity);
    const request = () => app.request('/api/auth/me', { headers: { 'x-test-user': 'ada@example.com' } }, env);

    const first = await request();
    const second = await request();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect((await database.direct.query('SELECT id FROM users')).rowCount).toBe(1);
    await database.close();
  });

  it('stores neither passwords nor application sessions', async () => {
    const database = await postgresTestDatabase();
    const columns = await database.direct.query(`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'users' ORDER BY column_name`);
    const sessions = await database.direct.query(`SELECT table_name FROM information_schema.tables
      WHERE table_name = 'sessions'`);

    expect(columns.rows.map((row: { column_name: string }) => row.column_name)).not.toEqual(expect.arrayContaining([
      'password_hash', 'password_salt', 'password_iterations',
    ]));
    expect(sessions.rowCount).toBe(0);
    await database.close();
  });

  it('removes application-owned register, login, and logout endpoints', async () => {
    const database = await postgresTestDatabase();
    const app = createApp(database.factory, identity);

    for (const route of ['register', 'login', 'logout']) {
      const response = await app.request(`/api/auth/${route}`, { method: 'POST' }, env);
      expect(response.status).toBe(404);
    }
    await database.close();
  });

  it('rejects cross-origin browser mutations before opening the database', async () => {
    const app = createApp();
    const response = await app.request('https://schema.example/api/projects', {
      method: 'POST',
      headers: { origin: 'https://attacker.example' },
    }, { ENVIRONMENT: 'production' } as Env);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Cross-origin request blocked' });
  });
});
