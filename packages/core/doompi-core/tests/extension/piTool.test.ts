import { Type } from 'typebox';
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { definePiTool } from '../../src/schemas/piTool';

describe('definePiTool', () => {
  it('retains native schema and detail types and registers the exact declaration', () => {
    const parameters = Type.Object({ path: Type.String() });
    const definition: ToolDefinition<typeof parameters, { count: number }> = {
      name: 'typed',
      label: 'Typed',
      description: 'Typed native tool',
      parameters,
      async execute(_id, input) {
        return { content: [{ type: 'text', text: input.path }], details: { count: 1 } };
      },
      renderResult(result) {
        return { render: () => [String(result.details.count)], invalidate() {} };
      },
    };
    const tool = definePiTool(definition);
    const registerTool = vi.fn();
    tool.register({ registerTool } as Pick<ExtensionAPI, 'registerTool'>);
    expect(registerTool).toHaveBeenCalledWith(definition);
    expect(tool.name).toBe('typed');
  });

  it('infers input from its schema instead of weakening handlers to any', () => {
    definePiTool({
      name: 'typed',
      label: 'Typed',
      description: 'Typed native tool',
      parameters: Type.Object({ path: Type.String() }),
      async execute(_id, input) {
        const path: string = input.path;
        // @ts-expect-error The declared schema has no missing field.
        void input.missing;
        return { content: [{ type: 'text', text: path }], details: undefined };
      },
    });
  });
});
