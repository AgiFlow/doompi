// @scaffold-generated
import { describe, expect, it } from 'vitest';
import {
  computerStateCallSummary,
  computerStateResultLines,
  computerStateToolName,
} from '../../src/web/computerStateToolRender.ts';

describe('the computer_state tool view', () => {
  it('names the tool the package registers', () => {
    expect(computerStateToolName).toBe('computer_state');
  });

  it('summarises the call and turns the result into toned lines', () => {
    expect(computerStateCallSummary({})).toBe('authorized window');
    expect(computerStateResultLines(null)).toEqual([]);
    expect(computerStateResultLines({ content: [{ type: 'text', text: 'one\ntwo' }], details: undefined })).toEqual([
      { text: 'one', tone: 'dim' },
      { text: 'two', tone: 'dim' },
    ]);
  });
});
