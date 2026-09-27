import { describe, expect, it } from 'vitest';

import type { CatalogTool } from '../../../src/services/mcpCatalog';
import { createMcpSessionApi } from '../../../src/services/mcpSessionApi';

const tool: CatalogTool = {
  piName: 'boomlink_mcp_send_link',
  toolName: 'send_link',
  serverName: 'boomlink-mcp',
  description: 'Send a link.',
  inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
};

function handler() {
  const api = createMcpSessionApi({ activeToolDefinitions: () => [tool] }, async () => (text) => text.length);
  return api.start({ scope: 'session', onNotice: () => undefined });
}

describe('MCP session API', () => {
  it('answers a reachable tool with its description, schema, and token cost', async () => {
    const response = await handler().fetch(new Request('http://session/tool?server=boomlink-mcp&tool=send_link'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      server: 'boomlink-mcp',
      tool: 'send_link',
      description: 'Send a link.',
      inputSchema: tool.inputSchema,
    });
    expect(body.tokens).toBe(
      JSON.stringify({ name: tool.piName, description: tool.description, parameters: tool.inputSchema }).length,
    );
  });

  it('refuses a tool mcp_use would not accept, and a request that names none', async () => {
    const api = handler();
    expect((await api.fetch(new Request('http://session/tool?server=boomlink-mcp&tool=other'))).status).toBe(404);
    expect((await api.fetch(new Request('http://session/tool?server=boomlink-mcp'))).status).toBe(400);
    expect((await api.fetch(new Request('http://session/elsewhere'))).status).toBe(404);
  });
});
