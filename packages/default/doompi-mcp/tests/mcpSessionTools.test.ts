import { describe, expect, it, vi } from 'vitest';

import { createMcpSessionToolsService } from '../src/services/mcpSessionTools';

describe('MCP session tools service', () => {
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
