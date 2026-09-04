import { Check } from 'typebox/value';
import { describe, expect, it } from 'vitest';
import {
  AUTHOR_FACADE_TOOL_NAMES,
  AuthorDescribeToolsInputSchema,
  AuthorUseToolsInputSchema,
} from '../src/schemas/authorFacade.ts';

describe('Author facade contracts', () => {
  it('keeps exactly two stable facade tool names', () => {
    expect(AUTHOR_FACADE_TOOL_NAMES).toEqual(['describe_author_tools', 'use_author_tools']);
  });

  it('accepts only an empty describe request', () => {
    expect(Check(AuthorDescribeToolsInputSchema, {})).toBe(true);
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
