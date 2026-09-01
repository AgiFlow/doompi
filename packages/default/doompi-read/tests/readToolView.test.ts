import { describe, expect, it } from 'vitest';
import { readCallView } from '../src/web/readToolView.ts';

describe('the read call view', () => {
  it('lists the path, offset, and limit the way the TUI heading does', () => {
    expect(readCallView({ path: 'src/a.ts', offset: 3, limit: 20 })).toEqual({
      path: 'src/a.ts',
      details: ['from 3', '20 lines'],
    });
    expect(readCallView({ path: 'src/a.ts' })).toEqual({ path: 'src/a.ts', details: [] });
    expect(readCallView({ offset: 'x' })).toEqual({ path: '', details: [] });
  });
});
