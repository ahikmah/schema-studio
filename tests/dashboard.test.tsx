import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Brand, newProjectInput } from '../src/client/App';

describe('general Schema Studio dashboard', () => {
  it('uses neutral product branding', () => {
    const markup = renderToStaticMarkup(<Brand />);

    expect(markup).toContain('Schema Studio');
    expect(markup).toContain('Design and document database schemas');
    expect(markup).toContain('S/S');
    expect(markup).not.toContain('MyBro');
  });

  it('creates a blank schema project', () => {
    const data = new FormData();
    data.set('name', 'Inventory');
    data.set('description', 'Warehouse schema');

    expect(newProjectInput(data)).toEqual({
      name: 'Inventory',
      description: 'Warehouse schema',
      dbml: '',
    });
  });
});
