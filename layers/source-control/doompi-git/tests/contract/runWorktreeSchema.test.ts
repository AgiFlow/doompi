import { describe, expect, it } from 'vitest';

import {
  RunWorktreeParams,
  RunWorktreeToolSchema,
  WORKTREE_ACTION_FIELDS,
  WORKTREE_ACTIONS,
} from '../../src/schemas/runWorktreeTool';
import { createRunWorktreeTool } from '../../src/tools/runWorktree';

/**
 * How Pi's Anthropic Messages adapter rebuilds a tool's input schema:
 * `{type:'object', properties: schema.properties ?? {}, required: schema.required ?? []}`.
 * A top-level union has neither key, so it reaches the model as an empty object.
 */
function anthropicInputSchema(schema: unknown): {
  properties: Record<string, { enum?: readonly string[] }>;
  required: readonly string[];
} {
  const source = schema as { properties?: Record<string, { enum?: readonly string[] }>; required?: readonly string[] };
  return { properties: source.properties ?? {}, required: source.required ?? [] };
}

describe('declared run_worktree schema', () => {
  it('still names every action after the Anthropic adapter flattens it', () => {
    const wire = anthropicInputSchema(RunWorktreeToolSchema);
    expect(wire.properties.action?.enum).toEqual(Object.values(WORKTREE_ACTIONS));
    expect(wire.required).toEqual(['action']);
  });

  it('is why the union cannot be declared directly', () => {
    expect(anthropicInputSchema(RunWorktreeParams).properties).toEqual({});
  });

  it('declares every field some action accepts, and no others', () => {
    const declared = Object.keys(anthropicInputSchema(RunWorktreeToolSchema).properties);
    const accepted = new Set(Object.values(WORKTREE_ACTION_FIELDS).flat());
    expect(declared.toSorted()).toEqual([...accepted].toSorted());
  });

  it('is the schema the Pi tool actually declares', () => {
    const tool = createRunWorktreeTool({} as never);
    expect(anthropicInputSchema(tool.parameters).properties.action?.enum).toEqual(Object.values(WORKTREE_ACTIONS));
  });
});
