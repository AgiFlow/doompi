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
      piName: 'boomlink_mcp_send_link',
      description: 'Send a link.',
      inputSchema: tool.inputSchema,
    });
    expect(body.tokens).toBe(
      JSON.stringify({ name: tool.piName, description: tool.description, parameters: tool.inputSchema }).length,
    );
  });

  it('refuses unavailable tools and a request that names none', async () => {
    const api = handler();
    expect((await api.fetch(new Request('http://session/tool?server=boomlink-mcp&tool=other'))).status).toBe(404);
    expect((await api.fetch(new Request('http://session/tool?server=boomlink-mcp'))).status).toBe(400);
    expect((await api.fetch(new Request('http://session/elsewhere'))).status).toBe(404);
  });
  it('keeps configured accounts and warnings separate when downstream names match', async () => {
    const personal = { ...tool, serverName: 'personal', toolName: 'search', piName: 'personal_search' };
    const work = { ...tool, serverName: 'work', toolName: 'search', piName: 'work_search' };
    const warning = { source: 'work/search (tools/call)', path: '/value', message: 'Expected string' };
    const api = createMcpSessionApi(
      {
        activeToolDefinitions: () => [personal, work],
        getToolWarnings: () => ({ work_search: [warning] }),
      },
      async () => (text) => text.length,
    ).start({ scope: 'session', onNotice: () => undefined });
    const personalDetail = await (
      await api.fetch(new Request('http://session/tool?server=personal&tool=search'))
    ).json();
    const workDetail = await (await api.fetch(new Request('http://session/tool?server=work&tool=search'))).json();
    expect(personalDetail).toMatchObject({ server: 'personal', tool: 'search', piName: 'personal_search' });
    expect(personalDetail).not.toHaveProperty('warnings');
    expect(workDetail).toMatchObject({ server: 'work', tool: 'search', piName: 'work_search', warnings: [warning] });
    expect((await api.fetch(new Request('http://session/tool?server=work&tool=work_search'))).status).toBe(404);
  });
});
