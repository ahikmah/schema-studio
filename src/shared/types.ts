export type PublicUser = {
  id: string;
  email: string;
  displayName: string;
};

export type ProjectRole = 'owner' | 'editor' | 'viewer';

export type Project = {
  id: string;
  name: string;
  description: string;
  dbml: string;
  layout: Record<string, { x: number; y: number }>;
  version: number;
  role: ProjectRole;
  revisionCount: number;
  createdAt: string;
  updatedAt: string;
};

export type Collaborator = {
  id: string;
  email: string;
  displayName: string;
  role: Exclude<ProjectRole, 'owner'>;
};

export type Revision = {
  id: string;
  revision_number: number;
  name: string;
  created_at: string;
  created_by_name: string;
};
