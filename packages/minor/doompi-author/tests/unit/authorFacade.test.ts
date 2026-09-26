import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';

import { AUTHOR_FACADE_TOOL_NAMES } from '../../src/constants/author';
import { AuthorDescribeToolsInputSchema, AuthorUseToolsInputSchema } from '../../src/schemas/authorFacade';

describe('Author facade contracts', () => {
  it('keeps exactly two stable facade tool names', () => {
    expect(AUTHOR_FACADE_TOOL_NAMES).toEqual(['describe_author_tools', 'use_author_tools']);
  });

  it('accepts discovery or one bounded canvas alias, but no unknown properties', () => {
    expect(Check(AuthorDescribeToolsInputSchema, {})).toBe(true);
    expect(Check(AuthorDescribeToolsInputSchema, { alias: 'homepage' })).toBe(true);
    expect(Check(AuthorDescribeToolsInputSchema, { alias: 'Invalid Name' })).toBe(false);
    expect(Check(AuthorDescribeToolsInputSchema, { '': '' })).toBe(false);
    expect(Check(AuthorDescribeToolsInputSchema, { extra: true })).toBe(false);
  });

  it('requires one token-fenced viewport capability invocation', () => {
    expect(
      Check(AuthorUseToolsInputSchema, {
        catalogToken: 'catalog-token',
        name: 'author_view_state',
        arguments: {},
      }),
    ).toBe(true);
    expect(Check(AuthorUseToolsInputSchema, { name: 'author_view_state', arguments: {} })).toBe(false);
    expect(
      Check(AuthorUseToolsInputSchema, {
        catalogToken: 'catalog-token',
        name: 'author_view_state',
        input: {},
      }),
    ).toBe(false);
  });
});
