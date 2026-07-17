import { describe, expect, it } from 'vitest';
import type { ProjectRole } from '../src/shared/types';
import type { IdentityResolver } from '../src/worker/access';
import { createApp, type Env } from '../src/worker/index';
import { canWrite } from '../src/worker/projects';
import { postgresTestDatabase } from './postgres-test';

const env = { ENVIRONMENT: 'test' } as Env;
const identity: IdentityResolver = async (request) => {
  const email = request.headers.get('x-test-user');
  return email ? { email, displayName: email.split('@')[0] } : null;
};

const provision = async (app: ReturnType<typeof createApp>, email: string) => {
  const response = await app.request('/api/auth/me', { headers: { 'x-test-user': email } }, env);
  expect(response.status).toBe(200);
};

describe('project authorization', () => {
  it.each<[ProjectRole | null, boolean]>([
    ['owner', true],
    ['editor', true],
    ['viewer', false],
    [null, false],
  ])('write permission for %s is %s', (role, allowed) => {
    expect(canWrite(role)).toBe(allowed);
  });

  it('protects writes, rejects stale versions, and preserves immutable revisions', async () => {
    const database = await postgresTestDatabase();
    const app = createApp(database.factory, identity);
    await provision(app, 'owner@example.com');
    await provision(app, 'member@example.com');

    const created = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'owner@example.com' },
      body: JSON.stringify({ name: 'MyBro Core', description: 'Runtime schema', dbml: 'Table users { id uuid [pk] }' }),
    }, env);
    expect(created.status).toBe(201);
    const project = await created.json<{ project: { id: string; version: number } }>();

    const addViewer = await app.request(`/api/projects/${project.project.id}/collaborators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'owner@example.com' },
      body: JSON.stringify({ email: 'member@example.com', role: 'viewer' }),
    }, env);
    expect(addViewer.status).toBe(201);

    const viewerWrite = await app.request(`/api/projects/${project.project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': 'member@example.com' },
      body: JSON.stringify({ dbml: 'viewer overwrite', layout: {}, version: 1 }),
    }, env);
    expect(viewerWrite.status).toBe(403);

    const layoutOnly = await app.request(`/api/projects/${project.project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': 'owner@example.com' },
      body: JSON.stringify({ dbml: 'Table users { id uuid [pk] }', layout: { 'public.users': { x: 120, y: 80 } }, version: 1 }),
    }, env);
    expect(layoutOnly.status).toBe(200);
    expect(await layoutOnly.json<{ version: number }>()).toMatchObject({ version: 1 });
    expect((await database.direct.query('SELECT layout_json, version FROM projects WHERE id = $1', [project.project.id])).rows[0])
      .toEqual({ layout_json: { 'public.users': { x: 120, y: 80 } }, version: 1 });

    const firstWrite = await app.request(`/api/projects/${project.project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': 'owner@example.com' },
      body: JSON.stringify({ dbml: 'Table users { id uuid [pk] name varchar }', layout: {}, version: 1 }),
    }, env);
    expect(firstWrite.status).toBe(200);

    const staleWrite = await app.request(`/api/projects/${project.project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-test-user': 'owner@example.com' },
      body: JSON.stringify({ dbml: 'stale overwrite', layout: {}, version: 1 }),
    }, env);
    expect(staleWrite.status).toBe(409);
    const stored = await database.direct.query('SELECT dbml, version FROM projects WHERE id = $1', [project.project.id]);
    expect(stored.rows[0]).toEqual({ dbml: 'Table users { id uuid [pk] name varchar }', version: 2 });

    const promote = await app.request(`/api/projects/${project.project.id}/collaborators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'owner@example.com' },
      body: JSON.stringify({ email: 'member@example.com', role: 'editor' }),
    }, env);
    expect(promote.status).toBe(200);

    const revision = await app.request(`/api/projects/${project.project.id}/revisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'member@example.com' },
      body: JSON.stringify({ name: 'Baseline' }),
    }, env);
    expect(revision.status).toBe(201);
    const snapshot = await database.direct.query('SELECT revision_number, name, dbml FROM project_revisions WHERE project_id = $1', [project.project.id]);
    expect(snapshot.rows[0]).toEqual({ revision_number: 1, name: 'Baseline', dbml: stored.rows[0].dbml });
    await database.close();
  });

  it('lets owners share with an email before that user signs in', async () => {
    const database = await postgresTestDatabase();
    const app = createApp(database.factory, identity);
    await provision(app, 'owner@example.com');

    const created = await app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'owner@example.com' },
      body: JSON.stringify({ name: 'Shared Schema', dbml: 'Table users { id uuid [pk] }' }),
    }, env);
    const project = await created.json<{ project: { id: string } }>();

    const invite = await app.request(`/api/projects/${project.project.id}/collaborators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': 'owner@example.com' },
      body: JSON.stringify({ email: 'new.member@example.com', role: 'viewer' }),
    }, env);

    expect(invite.status).toBe(201);
    expect(await invite.json<{ collaborator: { email: string; displayName: string; role: string } }>()).toMatchObject({
      collaborator: { email: 'new.member@example.com', displayName: 'new.member', role: 'viewer' },
    });
    expect((await database.direct.query('SELECT email FROM users WHERE email = $1', ['new.member@example.com'])).rowCount).toBe(1);
    await database.close();
  });
});
