import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { expect, it } from 'vitest';

import { McpSession } from '../src/services/mcpSession';
import { createMcpSessionToolsService } from '../src/services/mcpSessionTools';

// No proxy mocks: discovery and calls cross the pinned embedded proxy's HTTP client.
it.each(['request rejection', 'invalid output schema'] as const)(
  'discovers and invokes an SDKv1 HTTP tool, then recovers from %s on reload',
  async (failure) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-mcp-wire-'));
    let rejectDiscovery = false;
    let listRequests = 0;
    let calls = 0;
    const peers = new Set<Server>();
    const failures: unknown[] = [];
    const server = http.createServer((request, response) => {
      const peer = new Server({ name: 'legacy-wire-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      peers.add(peer);
      peer.setRequestHandler(ListToolsRequestSchema, async () => {
        listRequests++;
        if (rejectDiscovery && failure === 'request rejection') throw new Error('controlled tools/list rejection');
        return {
          tools: [
            {
              name: 'hello',
              description: 'Return a harmless greeting',
              inputSchema: { type: 'object', properties: {} },
              annotations: { readOnlyHint: true },
              ...(rejectDiscovery && failure === 'invalid output schema'
                ? { outputSchema: { allOf: [{ type: 'object', properties: {} }] } }
                : {}),
            },
          ],
        };
      });
      peer.setRequestHandler(CallToolRequestSchema, async (message) => {
        expect(message.params.name).toBe('hello');
        calls++;
        return { content: [{ type: 'text', text: 'hello from SDKv1' }] };
      });
      response.on('close', () => {
        peers.delete(peer);
        void peer.close().catch((error: unknown) => failures.push(error));
      });
      void peer
        .connect(transport)
        .then(() => transport.handleRequest(request, response))
        .catch((error: unknown) => {
          failures.push(error);
          response.writeHead(500).end();
        });
    });
    const session = new McpSession({
      environment: {},
      tokenStore: { read: async () => undefined, write: async () => undefined, clear: async () => undefined },
    });
    const tools = createMcpSessionToolsService(session, 'wire-regression');
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected loopback TCP address');
      fs.writeFileSync(
        path.join(repoRoot, '.mcp.json'),
        JSON.stringify({ mcpServers: { legacy: { type: 'http', url: `http://127.0.0.1:${address.port}/mcp` } } }),
      );
      session.install({ repoRoot, stagingDirectory: path.join(repoRoot, '.staging') });
      await session.start();
      await expect
        .poll(() => session.getSnapshot().servers, { timeout: 10000 })
        .toEqual([{ name: 'legacy', state: 'connected', tools: ['legacy_hello'], resourceCount: 0 }]);
      await expect(tools.invoke('legacy_hello', {})).resolves.toMatchObject({
        content: [{ type: 'text', text: 'hello from SDKv1' }],
      });
      expect(tools.snapshot()).toMatchObject([
        {
          piName: 'legacy_hello',
          serverName: 'legacy',
          toolName: 'hello',
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
        },
      ]);
      expect(calls).toBe(1);
      expect(listRequests).toBeGreaterThan(0);

      rejectDiscovery = true;
      const previousLists = listRequests;
      await session.start();
      await expect.poll(() => listRequests, { timeout: 10000 }).toBeGreaterThan(previousLists);
      const discoveryError = 'Could not discover tools for MCP server "legacy".';
      await expect.poll(() => session.getSnapshot().servers[0]?.error).toBe(discoveryError);
      expect(session.getSnapshot().servers[0]?.tools).toEqual([]);
      expect(tools.snapshot()).toEqual([]);
      expect(session.getDiagnostics().filter((message) => message === discoveryError)).toHaveLength(1);
      expect(session.getDiagnostics().join('\n')).not.toContain('controlled tools/list rejection');
      await expect(tools.invoke('legacy_hello', {})).rejects.toThrow('not available');

      await session.start();
      await expect.poll(() => session.getSnapshot().servers[0]?.error).toBe(discoveryError);
      expect(session.getDiagnostics().filter((message) => message === discoveryError)).toHaveLength(1);

      rejectDiscovery = false;
      await session.start();
      await expect.poll(() => session.getSnapshot().servers[0]?.tools, { timeout: 10000 }).toEqual(['legacy_hello']);
      await expect(tools.invoke('legacy_hello', {})).resolves.toMatchObject({
        content: [{ type: 'text', text: 'hello from SDKv1' }],
      });
      expect(session.getSnapshot().servers[0]?.error).toBeUndefined();
      expect(calls).toBe(2);
      expect(failures).toEqual([]);
    } finally {
      await session.dispose();
      await Promise.all([...peers].map((peer) => peer.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  },
  30000,
);
