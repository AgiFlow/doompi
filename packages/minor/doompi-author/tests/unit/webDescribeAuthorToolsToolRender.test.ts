import { describe, expect, it } from 'vitest';
import {
  describeAuthorToolsCallSummary,
  describeAuthorToolsResultLines,
  describeAuthorToolsToolName,
} from '../../src/web/describeAuthorToolsToolRender.ts';

describe('the describe_author_tools tool view', () => {
  it('names the tool the package registers', () => {
    expect(describeAuthorToolsToolName).toBe('describe_author_tools');
  });

  it('summarises the call and turns the result into toned lines', () => {
    expect(describeAuthorToolsCallSummary({ path: 'src/a.ts' })).toBe('');
    expect(describeAuthorToolsCallSummary({})).toBe('');
    expect(describeAuthorToolsResultLines(null)).toEqual([]);
    expect(
      describeAuthorToolsResultLines({ content: [{ type: 'text', text: 'one\ntwo' }], details: undefined }),
    ).toEqual([
      { text: 'one', tone: 'dim' },
      { text: 'two', tone: 'dim' },
    ]);
  });
});
