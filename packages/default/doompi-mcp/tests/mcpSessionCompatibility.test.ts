import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { AuthEntry } from '@agimon-ai/mcp-proxy';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { expect, it } from 'vitest';

import { McpSession } from '../src/services/mcpSession';
import { createMcpSessionToolsService } from '../src/services/mcpSessionTools';
import { createMcpToolCollection } from '../src/services/mcpToolCollection';

// No proxy mocks: discovery and calls cross the pinned embedded proxy's HTTP client.
it.each(['request rejection', 'invalid output schema'] as const)(
  'discovers and invokes an SDKv1 HTTP tool, then recovers from %s on reload',
  async (failure) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-mcp-wire-'));
    let rejectDiscovery = false;
    let invalidOutput = false;
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
              outputSchema:
                rejectDiscovery && failure === 'invalid output schema'
                  ? { allOf: [{ type: 'object', properties: {} }] }
                  : { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
            },
          ],
        };
      });
      peer.setRequestHandler(CallToolRequestSchema, async (message) => {
        expect(message.params.name).toBe('hello');
        calls++;
        return {
          content: [{ type: 'text', text: 'hello from SDKv1' }],
          structuredContent: { value: invalidOutput ? 42 : 'valid' },
        };
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

      const declaration = createMcpToolCollection(session).snapshot()[0];
      if (!('register' in declaration)) throw new Error('Expected Pi tool declaration');
      let direct: ToolDefinition | undefined;
      declaration.register({
        registerTool: (tool: ToolDefinition) => {
          direct = tool;
        },
      } as ExtensionAPI);
      if (!direct) throw new Error('Expected direct Pi declaration');
      invalidOutput = true;
      await direct.execute('invalid-direct', {}, undefined, undefined, {} as never);
      expect(session.getToolWarnings().legacy_hello).toEqual([
        expect.objectContaining({ source: 'legacy/hello (tools/call)' }),
      ]);
      invalidOutput = false;
      await direct.execute('valid-direct', {}, undefined, undefined, {} as never);
      expect(calls).toBe(3);
      expect(session.getToolWarnings()).toEqual({});

      rejectDiscovery = true;
      const previousLists = listRequests;
      await session.start();
      await expect.poll(() => listRequests, { timeout: 10000 }).toBeGreaterThan(previousLists);
      if (failure === 'invalid output schema') {
        await expect.poll(() => session.getToolWarnings().mcp_use?.length).toBeGreaterThan(0);
        await expect
          .poll(() => tools.snapshot()[0]?.outputSchema)
          .toEqual({
            allOf: [{ type: 'object', properties: {} }],
          });
        expect(session.getSnapshot().servers[0]?.error).toBeUndefined();
        expect(tools.snapshot()).toHaveLength(1);
        expect(session.getToolWarnings().mcp_use?.[0]?.source).toBe('legacy/hello (tools/list)');
        const current = createMcpToolCollection(session).snapshot()[0];
        if (!('register' in current)) throw new Error('Expected Pi tool declaration');
        current.register({
          registerTool: (tool: ToolDefinition) => {
            direct = tool;
          },
        } as ExtensionAPI);
        await direct.execute('descriptor-warning', {}, undefined, undefined, {} as never);
        expect(session.getToolWarnings().legacy_hello).toEqual([
          expect.objectContaining({ source: 'legacy/hello (tools/list)' }),
        ]);
      } else {
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
      }

      const callsBeforeRecovery = calls;
      rejectDiscovery = false;
      await session.start();
      await expect.poll(() => session.getSnapshot().servers[0]?.tools, { timeout: 10000 }).toEqual(['legacy_hello']);
      await expect
        .poll(() => tools.snapshot()[0]?.outputSchema)
        .toEqual({
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        });
      await expect(tools.invoke('legacy_hello', {})).resolves.toMatchObject({
        content: [{ type: 'text', text: 'hello from SDKv1' }],
      });
      expect(session.getSnapshot().servers[0]?.error).toBeUndefined();
      expect(calls).toBe(callsBeforeRecovery + 1);
      expect(session.getToolWarnings()).toEqual({});
      invalidOutput = true;
      const mismatched = await tools.invoke('legacy_hello', {});
      expect(mismatched.content).toEqual([{ type: 'text', text: 'hello from SDKv1' }]);
      expect(mismatched.details).toMatchObject({ blocks: [{ type: 'structured', value: { value: 42 } }] });
      expect(calls).toBe(callsBeforeRecovery + 2);
      expect(session.getToolWarnings().mcp_use).toEqual([
        expect.objectContaining({ source: 'legacy/hello (tools/call)' }),
      ]);
      expect(JSON.stringify(session.getToolWarnings())).not.toContain('42');
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

// Saved-token isolation only, with no interactive OAuth provider or real credentials.
it('keeps same-endpoint accounts independent across concurrent direct calls and a per-entry reconnect', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-mcp-accounts-'));
  const peers = new Set<Server>();
  const failures: unknown[] = [];
  const calls: { account: string; tool: string }[] = [];
  const reads: string[] = [];
  const entries = new Map<string, AuthEntry>();
  const server = http.createServer((request, response) => {
    const account =
      request.headers.authorization === 'Bearer synthetic-personal'
        ? 'personal'
        : request.headers.authorization === 'Bearer synthetic-work'
          ? 'work'
          : 'unauthenticated';
    const peer = new Server({ name: 'shared-account-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    peers.add(peer);
    peer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'search',
          description: 'Return a harmless account marker',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }));
    peer.setRequestHandler(CallToolRequestSchema, async (message) => {
      calls.push({ account, tool: message.params.name });
      return { content: [{ type: 'text', text: account }] };
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
    tokenStore: {
      read: async (name) => {
        reads.push(name);
        return entries.get(name);
      },
      write: async (name, value) => {
        entries.set(name, value);
      },
      clear: async (name) => {
        entries.delete(name);
      },
    },
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback TCP address');
    const url = `http://127.0.0.1:${address.port}/mcp`;
    for (const name of ['personal', 'work']) {
      entries.set(name, { serverUrl: url, tokens: { access_token: `synthetic-${name}`, token_type: 'Bearer' } });
    }
    fs.writeFileSync(
      path.join(repoRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: { personal: { type: 'http', url }, work: { type: 'http', url } },
      }),
    );
    session.install({ repoRoot, stagingDirectory: path.join(repoRoot, '.staging') });
    await session.start();
    const tools = createMcpSessionToolsService(session, 'account-regression');
    await expect
      .poll(
        () =>
          tools
            .snapshot()
            .map(({ piName }) => piName)
            .sort(),
        { timeout: 10000 },
      )
      .toEqual(['personal_search', 'work_search']);
    expect(tools.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ piName: 'personal_search', serverName: 'personal', toolName: 'search' }),
        expect.objectContaining({ piName: 'work_search', serverName: 'work', toolName: 'search' }),
      ]),
    );
    const direct = new Map<string, ToolDefinition>();
    for (const declaration of createMcpToolCollection(session).snapshot()) {
      if (!('register' in declaration)) throw new Error('Expected Pi tool declaration');
      declaration.register({
        registerTool: (tool: ToolDefinition) => {
          direct.set(tool.name, tool);
        },
      } as ExtensionAPI);
    }
    const invoke = async (name: string) => {
      const tool = direct.get(`${name}_search`);
      if (!tool) throw new Error(`Missing direct declaration for ${name}`);
      return tool.execute(`call-${name}`, {}, undefined, undefined, {} as never);
    };
    const results = await Promise.all([invoke('personal'), invoke('work')]);
    expect(results[0]).toMatchObject({ content: [{ type: 'text', text: 'personal' }] });
    expect(results[1]).toMatchObject({ content: [{ type: 'text', text: 'work' }] });
    expect(calls).toEqual(
      expect.arrayContaining([
        { account: 'personal', tool: 'search' },
        { account: 'work', tool: 'search' },
      ]),
    );
    expect(reads).toEqual(expect.arrayContaining(['personal', 'work']));
    const projected = tools.project();
    const projectedResults = await Promise.all(projected.map((tool) => tool.execute('projected', {})));
    expect(projectedResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: [{ type: 'text', text: 'personal' }],
          details: { server: 'personal', tool: 'search' },
        }),
        expect.objectContaining({
          content: [{ type: 'text', text: 'work' }],
          details: { server: 'work', tool: 'search' },
        }),
      ]),
    );
    expect(JSON.stringify(session.getSnapshot())).not.toContain('synthetic-');

    const manager = session.getClientManager();
    if (!manager) throw new Error('Expected running client manager');
    const workConnection = await manager.ensureConnected('work');
    const savedWork = entries.get('work');
    await manager.disconnectServer('personal');
    await expect(invoke('work')).resolves.toMatchObject({ content: [{ type: 'text', text: 'work' }] });
    await manager.ensureConnected('personal');
    await expect
      .poll(
        () =>
          tools
            .snapshot()
            .map(({ piName }) => piName)
            .sort(),
        { timeout: 10000 },
      )
      .toEqual(['personal_search', 'work_search']);
    await expect(tools.invoke('personal_search', {})).resolves.toMatchObject({
      content: [{ type: 'text', text: 'personal' }],
    });
    await expect(invoke('work')).resolves.toMatchObject({ content: [{ type: 'text', text: 'work' }] });
    expect(await manager.ensureConnected('work')).toBe(workConnection);
    expect(entries.get('work')).toEqual(savedWork);
    expect(calls).toHaveLength(7);
    tools.dispose();
    expect(failures).toEqual([]);
  } finally {
    await session.dispose();
    await Promise.all([...peers].map((peer) => peer.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}, 30000);
