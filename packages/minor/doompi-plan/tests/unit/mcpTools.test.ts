import type { DoomHeadlessExecutionContext, DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcpFacet';
import { describe, expect, it, vi } from 'vitest';

import { bindMcpTool, type McpToolCatalog, PLAN_MCP_TOOLS_SERVICE } from '../../src/services/mcpTools';

const TOOL_NAMES = ['complete_plan', 'record_debug_evidence', 'run_fable_plan', 'write_plan'] as const;

function fixture() {
  let activeModes: string[] = [];
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'written' }] }));
  const tool = {
    name: 'write_plan',
    description: 'Write the plan.',
    parameters: { type: 'object' },
    execute,
  } as unknown as DoomHeadlessTool;
  const catalog: McpToolCatalog = {
    get: (name) => (name === tool.name ? tool : undefined),
    names: () => TOOL_NAMES,
  };
  const execution = {} as DoomHeadlessExecutionContext;
  const context = {
    execution,
    services: { get: (name: string) => (name === PLAN_MCP_TOOLS_SERVICE ? catalog : undefined) },
    selection: {
      read: () => ({ majorMode: 'copilot', activeLayers: [], domains: [], state: { 'minor-mode': activeModes } }),
      change: async () => undefined,
    },
    signal: new AbortController().signal,
  } as unknown as DoomMcpPluginContext;
  return {
    gated: bindMcpTool(context, tool.name),
    execute,
    setActiveModes: (modes: string[]) => {
      activeModes = modes;
    },
  };
}

describe('plan remote MCP tool gate', () => {
  it('requires explicit nonempty Markdown and forwards it without reading the local transcript', async () => {
    const test = fixture();
    test.setActiveModes(['plan']);
    expect(test.gated.parameters).toMatchObject({ required: ['markdown'] });
    for (const args of [{}, { markdown: '' }, { markdown: '   ' }, { markdown: 42 }]) {
      expect(() =>
        test.gated.execute('invalid', args, undefined, undefined, {} as DoomHeadlessExecutionContext),
      ).toThrow('markdown argument');
    }
    expect(test.execute).not.toHaveBeenCalled();
    await test.gated.execute(
      'remote',
      { markdown: '# Remote plan' },
      undefined,
      undefined,
      {} as DoomHeadlessExecutionContext,
    );
    expect(test.execute).toHaveBeenCalledWith(
      'remote',
      { markdown: '# Remote plan' },
      expect.any(AbortSignal),
      undefined,
      expect.any(Object),
    );
  });

  it('checks live minor mode state for every call without hiding the cached tool or skill', async () => {
    const test = fixture();

    expect(() => test.gated.execute('inactive', {}, undefined, undefined, {} as DoomHeadlessExecutionContext)).toThrow(
      'Plan minor mode is inactive. Inactive Plan tools: complete_plan, record_debug_evidence, run_fable_plan, write_plan.',
    );
    expect(test.execute).not.toHaveBeenCalled();

    test.setActiveModes(['plan']);
    await expect(
      test.gated.execute('active', { markdown: '# Plan' }, undefined, undefined, {} as DoomHeadlessExecutionContext),
    ).resolves.toMatchObject({ content: [{ text: 'written' }] });
    expect(test.execute).toHaveBeenCalledOnce();

    test.setActiveModes([]);
    expect(() =>
      test.gated.execute('inactive-again', {}, undefined, undefined, {} as DoomHeadlessExecutionContext),
    ).toThrow('Plan minor mode is inactive.');
    expect(test.execute).toHaveBeenCalledOnce();
  });
});
