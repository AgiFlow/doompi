import type { DoomHeadlessExecutionContext, DoomHeadlessTool } from '@agimon-ai/doompi-core/headless';
import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcp-facet';
import { describe, expect, it, vi } from 'vitest';

import { createMcpServerRoot } from '../src/extensions/workspaces/sessions/(backend)/_lib/serverRoot';
import {
  bindMcpHeadlessTool,
  MCP_HEADLESS_TOOLS_SERVICE,
  type McpHeadlessToolCatalog,
} from '../src/services/mcpHeadlessTools';

function contextFor(tool: DoomHeadlessTool, lifecycle: AbortController) {
  const get = vi.fn(<T>(name: string): T | undefined => {
    if (name !== MCP_HEADLESS_TOOLS_SERVICE) return undefined;
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

describe('MCP headless tools', () => {
  it('mounts the root-owned mcp_use tool instead of creating a second runtime', () => {
    const root = createMcpServerRoot();
    let catalog: McpHeadlessToolCatalog | undefined;
    root.services[0]!({
      plugin: (plugin: (context: { provide(name: string, value: McpHeadlessToolCatalog): void }) => void) => {
        plugin({ provide: (_name, value) => (catalog = value) });
      },
    } as never);

    expect(catalog?.get('mcp_use')).toBe(root.value.tools[0]);
  });

  it('binds the started session tool through its mounted service and lifecycle', async () => {
    let receivedSignal: AbortSignal | undefined;
    const execute = vi.fn((_id, _parameters, signal) => {
      receivedSignal = signal;
      return Promise.resolve({ content: [{ type: 'text' as const, text: 'ok' }] });
    });
    const tool = {
      name: 'mcp_use',
      label: 'MCP use',
      description: 'test',
      parameters: {},
      execute,
    } as DoomHeadlessTool;
    const lifecycle = new AbortController();
    const { context, get } = contextFor(tool, lifecycle);

    const bound = bindMcpHeadlessTool(context, 'mcp_use');
    await bound.execute('call', {}, undefined, undefined, context.execution);

    expect(get).toHaveBeenCalledWith(MCP_HEADLESS_TOOLS_SERVICE);
    expect(receivedSignal?.aborted).toBe(false);
    lifecycle.abort();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it('rejects a tool that is not mounted in the session catalog', () => {
    const lifecycle = new AbortController();
    const context = {
      services: { get: () => ({ get: () => undefined }) as McpHeadlessToolCatalog },
      signal: lifecycle.signal,
    } as unknown as DoomMcpPluginContext;

    expect(() => bindMcpHeadlessTool(context, 'mcp_use')).toThrow('MCP tool is unavailable: mcp_use');
  });
});
