import type { DoomHeadlessExecutionContext, DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcp-facet';
import { describe, expect, it, vi } from 'vitest';

import { bindMcpTool, TEAM_MCP_TOOLS_SERVICE, type McpToolCatalog } from '../../src/services/mcpTools';

function contextFor(tool: DoomHeadlessTool, lifecycle: AbortController) {
  const get = vi.fn(<T>(name: string): T | undefined => {
    if (name !== TEAM_MCP_TOOLS_SERVICE) return undefined;
    return { get: (toolName: string) => (toolName === tool.name ? tool : undefined) } as T;
  });
  const context = {
    execution: {} as DoomHeadlessExecutionContext,
    services: { get },
    selection: { read: vi.fn(), change: vi.fn() },
    signal: lifecycle.signal,
  } as unknown as DoomMcpPluginContext;
  return { context, get };
}

describe('Team MCP tools', () => {
  it('binds a mounted tool through the session service and plugin lifecycle', async () => {
    let receivedSignal: AbortSignal | undefined;
    const execute = vi.fn((_id, _parameters, signal) => {
      receivedSignal = signal;
      return Promise.resolve({ content: [{ type: 'text' as const, text: 'ok' }] });
    });
    const tool = {
      name: 'intercom',
      label: 'Intercom',
      description: 'test',
      parameters: {},
      execute,
    } as DoomHeadlessTool;
    const lifecycle = new AbortController();
    const { context, get } = contextFor(tool, lifecycle);

    const bound = bindMcpTool(context, 'intercom');
    await bound.execute('call', {}, undefined, undefined, context.execution);

    expect(get).toHaveBeenCalledWith(TEAM_MCP_TOOLS_SERVICE);
    expect(receivedSignal?.aborted).toBe(false);
    lifecycle.abort();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('rejects a tool that is not mounted in the session catalog', () => {
    const lifecycle = new AbortController();
    const context = {
      services: { get: () => ({ get: () => undefined }) as McpToolCatalog },
      signal: lifecycle.signal,
    } as unknown as DoomMcpPluginContext;

    expect(() => bindMcpTool(context, 'subagent')).toThrow('Team tool is unavailable: subagent');
  });
});
