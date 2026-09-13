import { describe, expect, it } from 'vitest';

import {
  computerExecCallSummary,
  computerExecResultLines,
  computerExecToolName,
} from '../../src/web/lib/computerExecToolRender';

describe('the computer_exec tool view', () => {
  it('names and summarises the registered tool', () => {
    expect(computerExecToolName).toBe('computer_exec');
    expect(computerExecCallSummary({ scriptPath: '/trusted/fill-form.ts' })).toBe('/trusted/fill-form.ts');
    expect(computerExecCallSummary({})).toBe('');
  });

  it('turns the result into toned lines', () => {
    expect(computerExecResultLines(null)).toEqual([]);
    expect(computerExecResultLines({ content: [{ type: 'text', text: 'done' }], details: undefined })).toEqual([
      { text: 'done', tone: 'dim' },
    ]);
  });
});
