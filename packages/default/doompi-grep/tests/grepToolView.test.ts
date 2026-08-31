import { describe, expect, it } from 'vitest';
import { grepCallView } from '../web/grepToolView.ts';

describe('the grep call view', () => {
  it('lists the pattern, search path, glob, case flag, and limit the way the TUI heading does', () => {
    expect(grepCallView({ pattern: 'TODO', path: 'src', glob: '*.ts', ignoreCase: true, limit: 5 })).toEqual({
      pattern: 'TODO',
      details: ['src', '*.ts', 'ignore case', '5 matches'],
    });
    expect(grepCallView({ pattern: 'x' })).toEqual({ pattern: 'x', details: ['.'] });
    expect(grepCallView({})).toEqual({ pattern: '', details: ['.'] });
  });
});
