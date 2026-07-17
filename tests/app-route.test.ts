import { describe, expect, it } from 'vitest';

const routes = await import('../src/client/App') as typeof import('../src/client/App') & {
  projectIdFromPath: (pathname: string) => string | null;
  projectPath: (projectId: string) => string;
};

describe('project routes', () => {
  it('maps project IDs to refresh-safe detail paths', () => {
    expect(routes.projectPath('abc-123')).toBe('/projects/abc-123');
    expect(routes.projectIdFromPath('/projects/abc-123')).toBe('abc-123');
    expect(routes.projectIdFromPath('/projects/a%20b/')).toBe('a b');
    expect(routes.projectIdFromPath('/')).toBeNull();
  });
});
