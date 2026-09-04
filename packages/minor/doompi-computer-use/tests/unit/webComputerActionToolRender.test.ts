// @scaffold-generated
import { describe, expect, it } from 'vitest';
import {
  computerActionCallSummary,
  computerActionResultLines,
  computerActionToolName,
} from '../../src/web/computerActionToolRender.ts';

describe('the computer_action tool view', () => {
  it('names the tool the package registers', () => {
    expect(computerActionToolName).toBe('computer_action');
  });

  it('summarises the call and turns the result into toned lines', () => {
    expect(computerActionCallSummary({ kind: 'press', elementRef: 'button-1' })).toBe('press button-1');
    expect(computerActionCallSummary({})).toBe('');
    expect(computerActionResultLines(null)).toEqual([]);
    expect(computerActionResultLines({ content: [{ type: 'text', text: 'one\ntwo' }], details: undefined })).toEqual([
      { text: 'one', tone: 'dim' },
      { text: 'two', tone: 'dim' },
    ]);
  });
});
