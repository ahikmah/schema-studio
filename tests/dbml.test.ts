import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { exportPostgres, parseDbml } from '../src/client/dbml';

const dbmlTools = await import('../src/client/dbml') as typeof import('../src/client/dbml') & {
  arrangeTables: (model: ReturnType<typeof parsedModel>, algorithm: 'left-right' | 'snowflake' | 'compact') => Record<string, { x: number; y: number }>;
  updateTableSettings: (source: string, schema: string, oldName: string, newName: string, headerColor: string) => string;
};

const parsedModel = () => ({
  tables: ['parent', 'child', 'hub', 'leaf'].map((name) => ({ id: `public.${name}`, name, schema: 'public', columns: [] })),
  relations: [
    { id: 'parent-child', fromTable: 'public.child', fromColumn: 'parent_id', fromCardinality: 'N', toTable: 'public.parent', toColumn: 'id', toCardinality: '1', cardinality: 'N:1' },
    { id: 'hub-parent', fromTable: 'public.parent', fromColumn: 'hub_id', fromCardinality: 'N', toTable: 'public.hub', toColumn: 'id', toCardinality: '1', cardinality: 'N:1' },
    { id: 'hub-child', fromTable: 'public.child', fromColumn: 'hub_id', fromCardinality: 'N', toTable: 'public.hub', toColumn: 'id', toCardinality: '1', cardinality: 'N:1' },
    { id: 'hub-leaf', fromTable: 'public.leaf', fromColumn: 'hub_id', fromCardinality: 'N', toTable: 'public.hub', toColumn: 'id', toCardinality: '1', cardinality: 'N:1' },
  ],
});

const starter = await readFile(new URL('../examples/mybro-core.dbml', import.meta.url), 'utf8');

describe('MyBro core schema', () => {
  it('parses all runtime tables and their relationships', () => {
    const result = parseDbml(starter);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.model.tables).toHaveLength(22);
    expect(result.model.tables.map((table) => table.name)).toEqual(expect.arrayContaining([
      'organizations',
      'conversations',
      'messages',
      'document_chunks',
      'tool_executions',
      'evaluation_results',
    ]));
    expect(result.model.relations.length).toBeGreaterThan(20);
    const slug = result.model.tables.find((table) => table.name === 'organizations')?.columns.find((column) => column.name === 'slug');
    expect(slug?.type).toBe('varchar(80)');
  });

  it('exports portable PostgreSQL DDL with core tables', () => {
    const sql = exportPostgres(starter);

    expect(sql).toContain('CREATE TABLE');
    expect(sql).toContain('document_chunks');
    expect(sql).toContain('"embedding" real[] NOT NULL, -- pgvector vector(1536)');
    expect(sql).not.toContain('CHECK (vector_dims');
    expect(sql).toContain('CREATE INDEX "schema_studio_auto_idx_1" ON "memberships"');
    expect(sql).not.toMatch(/CREATE (?:UNIQUE )?INDEX ON/);
    expect(sql).toContain('DEFAULT gen_random_uuid()');
    expect(sql).toContain('DEFAULT now()');
    expect(sql).not.toMatch(/DEFAULT \((?:gen_random_uuid|now)\(\)\)/);
  });

  it('returns a stable error instead of throwing on invalid DBML', () => {
    const result = parseDbml('Table {');

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toBeTruthy();
  });

  it('marks foreign keys and preserves relation cardinality from the dependent side', () => {
    const source = `Table users {\n  id uuid [pk]\n}\n\nTable posts {\n  id uuid [pk]\n  user_id uuid [ref: > users.id]\n}\n\nTable profiles {\n  id uuid [pk]\n  user_id uuid [unique, ref: - users.id]\n}`;
    const result = parseDbml(source);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const posts = result.model.tables.find((table) => table.name === 'posts');
    const profiles = result.model.tables.find((table) => table.name === 'profiles');
    expect(posts?.columns.find((column) => column.name === 'user_id')?.foreignKey).toBe(true);
    expect(profiles?.columns.find((column) => column.name === 'user_id')?.foreignKey).toBe(true);
    expect(result.model.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromTable: 'public.posts',
        fromColumn: 'user_id',
        toTable: 'public.users',
        toColumn: 'id',
        cardinality: 'N:1',
      }),
      expect.objectContaining({
        fromTable: 'public.profiles',
        fromColumn: 'user_id',
        toTable: 'public.users',
        toColumn: 'id',
        cardinality: '1:1',
      }),
    ]));
  });

  it('round-trips table names, references, and header colors through DBML', () => {
    const source = `Table users [headerColor: #3498DB] {\n  id uuid [pk]\n}\n\nTable messages {\n  user_id uuid [ref: > users.id]\n}`;
    const parsed = parseDbml(source);

    expect(parsed.ok && (parsed.model.tables[0] as { headerColor?: string }).headerColor).toBe('#3498DB');

    const changed = dbmlTools.updateTableSettings(source, 'public', 'users', 'accounts', '#E74C3C');
    expect(changed).toContain('Table accounts');
    expect(changed).toContain('accounts.id');
    expect(changed).toContain('headerColor: #E74C3C');

    const reset = dbmlTools.updateTableSettings(changed, 'public', 'accounts', 'accounts', 'none');
    expect(reset).not.toContain('headerColor');
  });

  it('arranges tables left-right, around a hub, or in a compact grid', () => {
    const model = parsedModel();
    const leftRight = dbmlTools.arrangeTables(model, 'left-right');
    const snowflake = dbmlTools.arrangeTables(model, 'snowflake');
    const compact = dbmlTools.arrangeTables(model, 'compact');

    expect(leftRight['public.child'].x).toBeGreaterThan(leftRight['public.parent'].x);
    expect(snowflake['public.hub']).toEqual({ x: 0, y: 0 });
    expect(new Set(Object.values(compact).map(({ x }) => x)).size).toBeGreaterThan(1);
  });
});
