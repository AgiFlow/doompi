import type { DoomHeadlessExecutionContext, DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcp-facet';
import { describe, expect, it, vi } from 'vitest';

import { bindMcpTool, COMPUTER_USE_MCP_TOOLS_SERVICE, type McpToolCatalog } from '../../src/services/mcpTools';

const TOOL_NAMES = ['computer_state', 'computer_action', 'computer_exec'] as const;

function fixture() {
  let activeModes: string[] = [];
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'observed' }] }));
  const tool = {
    name: 'computer_state',
    description: 'Observe the computer.',
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
    services: { get: (name: string) => (name === COMPUTER_USE_MCP_TOOLS_SERVICE ? catalog : undefined) },
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

describe('computer use remote MCP tool gate', () => {
  it('checks live minor mode state for every call without hiding the cached tool', async () => {
    const test = fixture();

    expect(() => test.gated.execute('inactive', {}, undefined, undefined, {} as DoomHeadlessExecutionContext)).toThrow(
      'Computer Use minor mode is inactive. Inactive Computer Use tools: computer_action, computer_exec, computer_state.',
    );
    expect(test.execute).not.toHaveBeenCalled();

    test.setActiveModes(['computer-use']);
    await expect(
      test.gated.execute('active', {}, undefined, undefined, {} as DoomHeadlessExecutionContext),
    ).resolves.toMatchObject({ content: [{ text: 'observed' }] });
    expect(test.execute).toHaveBeenCalledOnce();

    test.setActiveModes([]);
    expect(() =>
      test.gated.execute('inactive-again', {}, undefined, undefined, {} as DoomHeadlessExecutionContext),
    ).toThrow('Computer Use minor mode is inactive.');
    expect(test.execute).toHaveBeenCalledOnce();
  });
});
