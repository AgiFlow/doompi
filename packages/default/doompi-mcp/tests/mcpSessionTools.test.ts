import type { DoomMcpPluginContext } from '@agimon-ai/doompi-core/mcp-facet';
import { describe, expect, it, vi } from 'vitest';

import projectSessionTools from '../src/extensions/workspaces/sessions/(backend)/tool/session_mcp.mcp';
import type { CatalogTool } from '../src/services/mcpCatalog';
import { createMcpSessionToolsService } from '../src/services/mcpSessionTools';

describe('MCP session tools service', () => {
  it('projects metadata, preserves results, and refreshes metadata-only changes', async () => {
    const tool: CatalogTool = {
      piName: 'docs_search',
      serverName: 'docs',
      toolName: 'search',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
      outputSchema: { type: 'object' },
    };
    const result = { content: [{ type: 'text', text: 'found' }], structuredContent: { count: 1 } };
    let changed: (() => void) | undefined;
    const stop = vi.fn();
    const service = {
      snapshot: () => [tool],
      invoke: vi.fn().mockResolvedValue(result),
      onChange: (listener: () => void) => {
        changed = listener;
        return stop;
      },
    };
    const refresh = vi.fn();
    const controller = new AbortController();
    const context = {
      services: { get: () => service },
      signal: controller.signal,
      refresh,
    } as unknown as DoomMcpPluginContext;
    const [remote] = projectSessionTools(context);
    expect(remote).toMatchObject({ annotations: { readOnlyHint: true }, outputSchema: { type: 'object' } });
    await expect(remote!.execute('call', {}, undefined, undefined, context.execution)).resolves.toEqual(result);
    changed!();
    expect(refresh).not.toHaveBeenCalled();
    tool.annotations = { readOnlyHint: false };
    changed!();
    expect(refresh).toHaveBeenCalledTimes(1);
    tool.outputSchema = { type: 'object', required: ['count'] };
    changed!();
    expect(refresh).toHaveBeenCalledTimes(2);
    controller.abort();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('forwards snapshots and calls to the existing session runtime', async () => {
    const tool = { piName: 'pencil_get_screenshot', serverName: 'pencil', toolName: 'get_screenshot', inputSchema: {} };
    const session = {
      activeToolDefinitions: vi.fn(() => [tool]),
      onChange: vi.fn(() => () => undefined),
      invokeTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
    };
    const service = createMcpSessionToolsService(session as never, 'session:mcp-tools');

    expect(service.snapshot()).toEqual([tool]);
    await expect(service.invoke(tool.piName, { quality: 'full' })).resolves.toEqual({
      content: [{ type: 'text', text: 'ok' }],
    });
    expect(session.invokeTool).toHaveBeenCalledWith(tool.piName, { quality: 'full' }, undefined);
  });
});
