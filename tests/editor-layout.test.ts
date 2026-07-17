import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(new URL('../src/client/styles.css', import.meta.url), 'utf8');

describe('editor layout', () => {
  it('constrains the CodeMirror wrapper so its scroller can overflow', () => {
    expect(styles).toContain('.code-panel > .cm-theme-light { height: calc(100% - 42px) !important; }');
    expect(styles).not.toContain('.code-panel .cm-editor');
  });

  it('keeps diagram tools usable on desktop and narrow screens', () => {
    expect(styles).toContain('.diagram-panel { display: flex; flex-direction: column;');
    expect(styles).toContain('.diagram-panel > .react-flow { flex: 1; min-height: 0; height: auto !important; }');
    expect(styles).toContain('.diagram-heading { height: 42px;');
    expect(styles).toContain('.diagram-actions { position: absolute; z-index: 6; top: 54px; right: 12px;');
    expect(styles).toContain('.diagram-actions button { white-space: nowrap;');
    expect(styles).toContain('.diagram-actions .arrange-menu { top: 0; right: calc(100% + 8px);');
    expect(styles).toContain('.react-flow__node { cursor: pointer; }');
    expect(styles).toContain('.react-flow__node.dragging { cursor: grabbing; }');
    expect(styles).toContain('.edge-end-label { position: absolute; min-width: 20px;');
    expect(styles).toContain('.arrange-menu');
    expect(styles).toContain('.table-inspector');
    expect(styles).toContain('.color-swatch');
    expect(styles).toContain('.table-inspector { inset: auto 8px 8px;');
    expect(styles).toContain('.project-card strong, .project-description, .project-meta, .role-chip { position: relative; z-index: 1;');
    expect(styles).toContain('.schema-glyph { position: absolute; z-index: 0;');
  });

  it('keeps editor notices above modal backdrops', () => {
    expect(styles).toContain('.editor-notice, .viewer-banner { position: fixed; z-index: 30;');
    expect(styles).toContain('.modal-backdrop { position: fixed; z-index: 20;');
  });
});
