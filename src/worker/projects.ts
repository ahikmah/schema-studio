import type { Hono } from 'hono';
import type { ProjectRole } from '../shared/types';
import type { Database } from './db';
import type { AppBindings, Env } from './index';

type CurrentUser = { id: string; email: string; display_name: string };
type CurrentUserFn = (request: Request, env: Env, db: Database) => Promise<CurrentUser | null>;
type Layout = Record<string, { x: number; y: number }>;

type ProjectRow = {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  dbml: string;
  layout_json: Layout | string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
};

export const canWrite = (role: ProjectRole | null) => role === 'owner' || role === 'editor';

export async function resolveProjectAccess(db: Database, projectId: string, userId: string): Promise<ProjectRole | null> {
  const result = await db.query<{ role: ProjectRole }>(`SELECT CASE WHEN p.owner_id = $1 THEN 'owner' ELSE pc.role END AS role
    FROM projects p
    LEFT JOIN project_collaborators pc ON pc.project_id = p.id AND pc.user_id = $1
    WHERE p.id = $2 AND (p.owner_id = $1 OR pc.user_id IS NOT NULL)`, [userId, projectId]);
  return result.rows[0]?.role ?? null;
}

const timestamp = (value: Date | string) => value instanceof Date ? value.toISOString() : value;
const layout = (value: Layout | string) => typeof value === 'string' ? JSON.parse(value) as Layout : value;

const view = (row: ProjectRow, role: ProjectRole, revisionCount = 0) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  dbml: row.dbml,
  layout: layout(row.layout_json),
  version: row.version,
  role,
  revisionCount: Number(revisionCount),
  createdAt: timestamp(row.created_at),
  updatedAt: timestamp(row.updated_at),
});

const body = async (request: Request) => {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > 1_200_000) throw new RangeError('Request too large');
  return request.json<Record<string, unknown>>();
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const authenticated = (request: Request, env: Env, db: Database, getUser: CurrentUserFn) => getUser(request, env, db);

export function registerProjectRoutes(app: Hono<AppBindings>, getUser: CurrentUserFn) {
  app.get('/api/projects', async (context) => {
    const db = context.var.db;
    const user = await authenticated(context.req.raw, context.env, db, getUser);
    if (!user) return context.json({ error: 'Authentication required' }, 401);
    const projects = await db.query<ProjectRow & { role: ProjectRole; revision_count: number }>(`SELECT p.*,
      CASE WHEN p.owner_id = $1 THEN 'owner' ELSE pc.role END AS role,
      (SELECT COUNT(*) FROM project_revisions pr WHERE pr.project_id = p.id) AS revision_count
      FROM projects p
      LEFT JOIN project_collaborators pc ON pc.project_id = p.id AND pc.user_id = $1
      WHERE p.owner_id = $1 OR pc.user_id IS NOT NULL
      ORDER BY p.updated_at DESC`, [user.id]);
    return context.json({ projects: projects.rows.map((project) => view(project, project.role, project.revision_count)) });
  });

  app.post('/api/projects', async (context) => {
    const db = context.var.db;
    const user = await authenticated(context.req.raw, context.env, db, getUser);
    if (!user) return context.json({ error: 'Authentication required' }, 401);
    let input: Record<string, unknown>;
    try { input = await body(context.req.raw); } catch (error) {
      return context.json({ error: error instanceof RangeError ? 'Request too large' : 'Invalid JSON' }, error instanceof RangeError ? 413 : 400);
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    const dbml = typeof input.dbml === 'string' ? input.dbml : '';
    if (!name || name.length > 100 || description.length > 500 || dbml.length > 1_048_576) {
      return context.json({ error: 'Invalid project details' }, 422);
    }
    const now = new Date();
    const row: ProjectRow = {
      id: crypto.randomUUID(), owner_id: user.id, name, description, dbml, layout_json: {}, version: 1, created_at: now, updated_at: now,
    };
    await db.query(`INSERT INTO projects
      (id, owner_id, name, description, dbml, layout_json, version, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [row.id, row.owner_id, row.name, row.description, row.dbml, JSON.stringify(row.layout_json), row.version, now]);
    return context.json({ project: view(row, 'owner') }, 201);
  });

  app.get('/api/projects/:projectId', async (context) => {
    const db = context.var.db;
    const user = await authenticated(context.req.raw, context.env, db, getUser);
    if (!user) return context.json({ error: 'Authentication required' }, 401);
    const projectId = context.req.param('projectId');
    const role = await resolveProjectAccess(db, projectId, user.id);
    if (!role) return context.json({ error: 'Project not found' }, 404);
    const row = (await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [projectId])).rows[0];
    return row ? context.json({ project: view(row, role) }) : context.json({ error: 'Project not found' }, 404);
  });

  app.patch('/api/projects/:projectId', async (context) => {
    const db = context.var.db;
    const user = await authenticated(context.req.raw, context.env, db, getUser);
    if (!user) return context.json({ error: 'Authentication required' }, 401);
    const projectId = context.req.param('projectId');
    const role = await resolveProjectAccess(db, projectId, user.id);
    if (!role) return context.json({ error: 'Project not found' }, 404);
    if (!canWrite(role)) return context.json({ error: 'Editor access required' }, 403);
    let input: Record<string, unknown>;
    try { input = await body(context.req.raw); } catch (error) {
      return context.json({ error: error instanceof RangeError ? 'Request too large' : 'Invalid JSON' }, error instanceof RangeError ? 413 : 400);
    }
    const dbml = typeof input.dbml === 'string' ? input.dbml : null;
    const version = typeof input.version === 'number' && Number.isInteger(input.version) ? input.version : null;
    const layoutJson = input.layout && typeof input.layout === 'object' ? JSON.stringify(input.layout) : '{}';
    if (dbml === null || dbml.length > 1_048_576 || version === null || layoutJson.length > 100_000) {
      return context.json({ error: 'Invalid project update' }, 422);
    }
    const updatedAt = new Date();
    const updated = await db.query<{ version: number; updated_at: Date | string }>(`UPDATE projects
      SET dbml = $1, layout_json = $2, version = version + CASE WHEN dbml <> $1 THEN 1 ELSE 0 END, updated_at = $3
      WHERE id = $4 AND version = $5 RETURNING version, updated_at`, [dbml, layoutJson, updatedAt, projectId, version]);
    if (!updated.rowCount) {
      const current = (await db.query<{ version: number }>('SELECT version FROM projects WHERE id = $1', [projectId])).rows[0];
      return context.json({ error: 'Project changed on the server', currentVersion: current?.version }, 409);
    }
    return context.json({ version: updated.rows[0].version, updatedAt: timestamp(updated.rows[0].updated_at) });
  });

  app.delete('/api/projects/:projectId', async (context) => {
    const db = context.var.db;
    const user = await authenticated(context.req.raw, context.env, db, getUser);
    if (!user) return context.json({ error: 'Authentication required' }, 401);
    const projectId = context.req.param('projectId');
    if (await resolveProjectAccess(db, projectId, user.id) !== 'owner') return context.json({ error: 'Project not found' }, 404);
    await db.query('DELETE FROM projects WHERE id = $1', [projectId]);
    return context.body(null, 204);
  });

  app.get('/api/projects/:projectId/collaborators', async (context) => {
    const db = context.var.db;
    const user = await authenticated(context.req.raw, context.env, db, getUser);
    if (!user) return context.json({ error: 'Authentication required' }, 401);
    const projectId = context.req.param('projectId');
    if (!await resolveProjectAccess(db, projectId, user.id)) return context.json({ error: 'Project not found' }, 404);
    const collaborators = await db.query(`SELECT u.id, u.email, u.display_name, pc.role, pc.created_at
      FROM project_collaborators pc JOIN users u ON u.id = pc.user_id WHERE pc.project_id = $1 ORDER BY u.email`, [projectId]);
    return context.json({ collaborators: collaborators.rows });
  });

  app.post('/api/projects/:projectId/collaborators', async (context) => {
    const db = context.var.db;
    const owner = await authenticated(context.req.raw, context.env, db, getUser);
    if (!owner) return context.json({ error: 'Authentication required' }, 401);
    const projectId = context.req.param('projectId');
    if (await resolveProjectAccess(db, projectId, owner.id) !== 'owner') return context.json({ error: 'Project not found' }, 404);
    let input: Record<string, unknown>;
    try { input = await body(context.req.raw); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const role = input.role === 'viewer' || input.role === 'editor' ? input.role : null;
    if (!role || !emailPattern.test(email) || email === owner.email) return context.json({ error: 'Invalid collaborator' }, 422);
    const displayName = email.split('@')[0].slice(0, 80);
    const collaborator = (await db.query<CurrentUser>(`INSERT INTO users (id, email, display_name, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $4)
      ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
      RETURNING id, email, display_name`, [crypto.randomUUID(), email, displayName, new Date()])).rows[0];
    const existed = (await db.query('SELECT role FROM project_collaborators WHERE project_id = $1 AND user_id = $2', [projectId, collaborator.id])).rowCount > 0;
    await db.query(`INSERT INTO project_collaborators (project_id, user_id, role, added_by, created_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role, added_by = EXCLUDED.added_by`,
      [projectId, collaborator.id, role, owner.id, new Date()]);
    return context.json({ collaborator: { id: collaborator.id, email: collaborator.email, displayName: collaborator.display_name, role } }, existed ? 200 : 201);
  });

  app.delete('/api/projects/:projectId/collaborators/:userId', async (context) => {
    const db = context.var.db;
    const owner = await authenticated(context.req.raw, context.env, db, getUser);
    if (!owner) return context.json({ error: 'Authentication required' }, 401);
    const projectId = context.req.param('projectId');
    if (await resolveProjectAccess(db, projectId, owner.id) !== 'owner') return context.json({ error: 'Project not found' }, 404);
    await db.query('DELETE FROM project_collaborators WHERE project_id = $1 AND user_id = $2', [projectId, context.req.param('userId')]);
    return context.body(null, 204);
  });

  app.get('/api/projects/:projectId/revisions', async (context) => {
    const db = context.var.db;
    const user = await authenticated(context.req.raw, context.env, db, getUser);
    if (!user) return context.json({ error: 'Authentication required' }, 401);
    const projectId = context.req.param('projectId');
    if (!await resolveProjectAccess(db, projectId, user.id)) return context.json({ error: 'Project not found' }, 404);
    const revisions = await db.query(`SELECT pr.id, pr.revision_number, pr.name, pr.created_at,
      u.display_name AS created_by_name FROM project_revisions pr JOIN users u ON u.id = pr.created_by
      WHERE pr.project_id = $1 ORDER BY pr.revision_number DESC`, [projectId]);
    return context.json({ revisions: revisions.rows });
  });

  app.post('/api/projects/:projectId/revisions', async (context) => {
    const db = context.var.db;
    const user = await authenticated(context.req.raw, context.env, db, getUser);
    if (!user) return context.json({ error: 'Authentication required' }, 401);
    const projectId = context.req.param('projectId');
    const role = await resolveProjectAccess(db, projectId, user.id);
    if (!role) return context.json({ error: 'Project not found' }, 404);
    if (!canWrite(role)) return context.json({ error: 'Editor access required' }, 403);
    let input: Record<string, unknown>;
    try { input = await body(context.req.raw); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 100) return context.json({ error: 'Invalid revision name' }, 422);
    const id = crypto.randomUUID();
    const project = (await db.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [projectId])).rows[0];
    const number = (await db.query<{ next: number }>(
      'SELECT COALESCE(MAX(revision_number), 0) + 1 AS next FROM project_revisions WHERE project_id = $1', [projectId])).rows[0].next;
    const created = await db.query(`INSERT INTO project_revisions
      (id, project_id, revision_number, name, dbml, layout_json, created_by, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, projectId, number, name, project.dbml, JSON.stringify(layout(project.layout_json)), user.id, new Date()]);
    return context.json({ revision: created.rows[0] }, 201);
  });

  app.get('/api/projects/:projectId/revisions/:revisionNumber', async (context) => {
    const db = context.var.db;
    const user = await authenticated(context.req.raw, context.env, db, getUser);
    if (!user) return context.json({ error: 'Authentication required' }, 401);
    const projectId = context.req.param('projectId');
    if (!await resolveProjectAccess(db, projectId, user.id)) return context.json({ error: 'Project not found' }, 404);
    const revision = (await db.query('SELECT * FROM project_revisions WHERE project_id = $1 AND revision_number = $2',
      [projectId, Number(context.req.param('revisionNumber'))])).rows[0];
    return revision ? context.json({ revision }) : context.json({ error: 'Revision not found' }, 404);
  });
}
