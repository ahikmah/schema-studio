BEGIN;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  dbml TEXT NOT NULL CHECK (length(dbml) <= 1048576),
  layout_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS project_collaborators (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  added_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS project_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  dbml TEXT NOT NULL CHECK (length(dbml) <= 1048576),
  layout_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (project_id, revision_number)
);

CREATE INDEX IF NOT EXISTS idx_projects_owner_updated ON projects(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_collaborators_user ON project_collaborators(user_id, project_id);
CREATE INDEX IF NOT EXISTS idx_revisions_project_number ON project_revisions(project_id, revision_number DESC);

COMMIT;
