import { describe, expect, it } from 'vitest';
import { clampSplit, editorReducer, initialEditorState } from '../src/client/editor-state';

describe('editor state', () => {
  it('keeps an invalid draft while preserving the last valid graph', () => {
    const validModel = { tables: [], relations: [] };
    const initial = initialEditorState('Table users { id uuid [pk] }', validModel);
    const changed = editorReducer(initial, {
      type: 'draftChanged',
      draft: 'Table users {',
      parsed: { ok: false, message: 'Expected a closing brace', line: 1 },
    });

    expect(changed.draft).toBe('Table users {');
    expect(changed.lastValidModel).toBe(validModel);
    expect(changed.parseError).toContain('line 1');
    expect(changed.saveState).toBe('dirty');
  });

  it('pauses autosave after an optimistic version conflict', () => {
    const state = editorReducer(initialEditorState('', { tables: [], relations: [] }), {
      type: 'conflict',
      serverVersion: 4,
    });

    expect(state.saveState).toBe('conflict');
    expect(state.serverVersion).toBe(4);
    expect(editorReducer(state, { type: 'saveStarted' })).toBe(state);
  });

  it('keeps the editor split within useful panel widths', () => {
    expect(clampSplit(10)).toBe(25);
    expect(clampSplit(47)).toBe(47);
    expect(clampSplit(90)).toBe(75);
  });
});
