import { describe, expect, it } from 'vitest';
import {
  useAuthorToolsCallSummary,
  useAuthorToolsResultLines,
  useAuthorToolsToolName,
} from '../../src/web/useAuthorToolsToolRender.ts';

describe('the use_author_tools tool view', () => {
  it('names the tool the package registers', () => {
    expect(useAuthorToolsToolName).toBe('use_author_tools');
  });

  it('summarises the call and turns the result into toned lines', () => {
    expect(useAuthorToolsCallSummary({ name: 'viewport:replace' })).toBe('viewport:replace');
    expect(useAuthorToolsCallSummary({})).toBe('');
    expect(useAuthorToolsResultLines(null)).toEqual([]);
    expect(useAuthorToolsResultLines({ content: [{ type: 'text', text: 'one\ntwo' }], details: undefined })).toEqual([
      { text: 'one', tone: 'dim' },
      { text: 'two', tone: 'dim' },
    ]);
  });
});
