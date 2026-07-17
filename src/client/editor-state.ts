import type { ParseResult, SchemaModel } from './dbml';

export type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

export type EditorState = {
  draft: string;
  lastValidModel: SchemaModel;
  parseError: string | null;
  saveState: SaveState;
  version: number;
  serverVersion?: number;
};

export type EditorAction =
  | { type: 'draftChanged'; draft: string; parsed: ParseResult }
  | { type: 'layoutChanged' }
  | { type: 'saveStarted' }
  | { type: 'saveSucceeded'; version: number }
  | { type: 'saveFailed' }
  | { type: 'conflict'; serverVersion?: number }
  | { type: 'reset'; draft: string; model: SchemaModel; version: number };

export const clampSplit = (percentage: number) => Math.min(75, Math.max(25, percentage));

export function initialEditorState(draft: string, model: SchemaModel, version = 1): EditorState {
  return { draft, lastValidModel: model, parseError: null, saveState: 'saved', version };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  if (state.saveState === 'conflict' && action.type === 'saveStarted') return state;
  switch (action.type) {
    case 'draftChanged':
      return {
        ...state,
        draft: action.draft,
        lastValidModel: action.parsed.ok ? action.parsed.model : state.lastValidModel,
        parseError: action.parsed.ok ? null : `${action.parsed.line ? `line ${action.parsed.line}: ` : ''}${action.parsed.message}`,
        saveState: state.saveState === 'conflict' ? 'conflict' : 'dirty',
      };
    case 'layoutChanged':
      return { ...state, saveState: state.saveState === 'conflict' ? 'conflict' : 'dirty' };
    case 'saveStarted':
      return { ...state, saveState: 'saving' };
    case 'saveSucceeded':
      return { ...state, version: action.version, serverVersion: undefined, saveState: 'saved' };
    case 'saveFailed':
      return { ...state, saveState: 'error' };
    case 'conflict':
      return { ...state, saveState: 'conflict', serverVersion: action.serverVersion };
    case 'reset':
      return initialEditorState(action.draft, action.model, action.version);
  }
}
