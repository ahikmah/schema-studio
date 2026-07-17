import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Project, PublicUser } from '../shared/types';
import { api, ApiError } from './api';

const Editor = lazy(() => import('./Editor').then((module) => ({ default: module.Editor })));

type Session = { user: PublicUser };
type ProjectList = { projects: Project[] };
type ProjectDetail = { project: Project };

export const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

export function projectIdFromPath(pathname: string) {
  const match = pathname.match(/^\/projects\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function Brand() {
  return <div className="brand" aria-label="Schema Studio">
    <span className="brand-mark" aria-hidden="true">S/S</span>
    <span><strong>Schema Studio</strong><small>Design and document database schemas</small></span>
  </div>;
}

export function newProjectInput(data: FormData) {
  return { name: data.get('name'), description: data.get('description'), dbml: '' };
}

function ProjectCard({ project, onOpen }: { project: Project; onOpen: () => void }) {
  return <button className="project-card" onClick={onOpen}>
    <span className={`role-chip role-${project.role}`}>{project.role}</span>
    <span className="schema-glyph" aria-hidden="true"><i /><i /><i /></span>
    <strong>{project.name}</strong>
    <span className="project-description">{project.description || 'No description'}</span>
    <span className="project-meta">v{project.version} · {project.revisionCount} revisions · {new Date(project.updatedAt).toLocaleDateString()}</span>
  </button>;
}

function Dashboard({ user, onLogout, onOpen, routeError }: { user: PublicUser; onLogout: () => void; onOpen: (project: Project) => void; routeError?: string }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setProjects((await api.get<ProjectList>('/api/projects')).projects);
      setError('');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Cannot load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const response = await api.post<ProjectDetail>('/api/projects', newProjectInput(data));
      setCreating(false);
      onOpen(response.project);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Cannot create project');
    }
  }

  return <main className="dashboard-shell">
    <header className="app-header"><Brand /><div className="account"><span><b>{user.displayName}</b><small>{user.email}</small></span><button className="ghost" onClick={onLogout}>Sign out</button></div></header>
    <section className="dashboard-head">
      <div><p className="eyebrow">Your database designs</p><h1>Schema workspace</h1><p>Private by default. Invite only the people who need the map.</p></div>
      <button className="primary" onClick={() => setCreating(true)}>+ New project</button>
    </section>
    {(routeError || error) && <p className="notice error" role="alert">{routeError || error} {!routeError && <button onClick={() => void load()}>Retry</button>}</p>}
    {creating && <form className="create-project" onSubmit={createProject}>
      <label>Project name<input name="name" required maxLength={100} placeholder="e.g. Inventory platform" autoFocus /></label>
      <label>Description<input name="description" maxLength={500} placeholder="Optional description" /></label>
      <div><button type="button" className="ghost" onClick={() => setCreating(false)}>Cancel</button><button className="primary">Create project</button></div>
    </form>}
    <section className="project-grid" aria-live="polite">
      {loading ? <p className="empty">Reading the map…</p> : projects.length ? projects.map((project) => <ProjectCard key={project.id} project={project} onOpen={() => onOpen(project)} />) : <div className="empty"><strong>No schemas yet.</strong><span>Create a project to start mapping your database.</span></div>}
    </section>
  </main>;
}

export function App() {
  const [user, setUser] = useState<PublicUser>();
  const [authError, setAuthError] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [routeLoading, setRouteLoading] = useState(Boolean(projectIdFromPath(window.location.pathname)));
  const [routeError, setRouteError] = useState('');

  const loadRoute = useCallback(async () => {
    const projectId = projectIdFromPath(window.location.pathname);
    if (!projectId) {
      setProject(null);
      setRouteLoading(false);
      setRouteError('');
      return;
    }
    setRouteLoading(true);
    try {
      const response = await api.get<ProjectDetail>(`/api/projects/${encodeURIComponent(projectId)}`);
      setProject(response.project);
      setRouteError('');
    } catch (reason) {
      setProject(null);
      setRouteError(reason instanceof ApiError ? reason.message : 'Cannot open this project');
      window.history.replaceState({}, '', '/');
    } finally {
      setRouteLoading(false);
    }
  }, []);

  useEffect(() => {
    api.get<Session>('/api/auth/me')
      .then(async (session) => {
        setUser(session.user);
        await loadRoute();
      })
      .catch(() => setAuthError(true));
    const handlePopState = () => { void loadRoute(); };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [loadRoute]);

  const openProject = (next: Project) => {
    window.history.pushState({}, '', projectPath(next.id));
    setRouteError('');
    setProject(next);
  };

  const closeProject = () => {
    window.history.pushState({}, '', '/');
    setProject(null);
  };

  const logout = () => window.location.assign('/cdn-cgi/access/logout');

  if (authError) return <main className="loading-screen"><Brand /><p className="notice error" role="alert">Cloudflare Access authentication failed.</p><button className="primary" onClick={() => window.location.reload()}>Retry</button></main>;
  if (!user || routeLoading) return <main className="loading-screen"><Brand /><span>Opening workspace…</span></main>;
  if (project) return <Suspense fallback={<main className="editor-loading"><h1>{project.name}</h1><p>Drawing the schema…</p></main>}><Editor initialProject={project} onBack={closeProject} onProjectChange={setProject} /></Suspense>;
  return <Dashboard user={user} onLogout={logout} onOpen={openProject} routeError={routeError} />;
}
