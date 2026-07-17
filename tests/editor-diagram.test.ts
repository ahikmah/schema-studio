import { describe, expect, it } from 'vitest';
import { diagramEdges, diagramExportBounds, diagramNodes } from '../src/client/Editor';
import type { SchemaModel } from '../src/client/dbml';

const model: SchemaModel = {
  tables: [
    { id: 'public.users', name: 'users', schema: 'public', columns: [] },
    { id: 'public.posts', name: 'posts', schema: 'public', columns: [] },
    { id: 'public.tags', name: 'tags', schema: 'public', columns: [] },
  ],
  relations: [
    {
      id: 'ref-posts-users',
      fromTable: 'public.posts',
      fromColumn: 'user_id',
      fromCardinality: 'N',
      toTable: 'public.users',
      toColumn: 'id',
      toCardinality: '1',
      cardinality: 'N:1',
    },
  ],
};

describe('editor diagram model', () => {
  it('puts cardinality on edge endpoints and highlights related tables', () => {
    const edges = diagramEdges(model, 'ref-posts-users');
    const idleEdges = diagramEdges(model);
    const nodes = diagramNodes(model, {}, true, 'ref-posts-users');

    expect(edges[0].label).toBe('user_id -> id');
    expect(idleEdges[0].label).toBe('');
    expect(edges[0].data).toMatchObject({ sourceLabel: 'N', targetLabel: '1' });
    expect(edges[0].className).toContain('selected-schema-edge');
    expect(nodes.find((node) => node.id === 'public.posts')?.className).toContain('related-table-node');
    expect(nodes.find((node) => node.id === 'public.users')?.className).toContain('related-table-node');
    expect(nodes.find((node) => node.id === 'public.tags')?.className).toBe('');
  });

  it('computes padded high-resolution PNG export bounds from table layout', () => {
    expect(diagramExportBounds(model, {
      'public.users': { x: 10, y: 20 },
      'public.posts': { x: 420, y: 120 },
      'public.tags': { x: 100, y: 520 },
    })).toMatchObject({
      x: -70,
      y: -60,
      width: 820,
      height: 756,
      scale: 3,
    });
  });
});
