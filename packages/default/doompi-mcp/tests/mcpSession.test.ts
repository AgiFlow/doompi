import { definePiExtension } from '@agimon-ai/doompi-core/piExtension';
import { Context } from '@deepseek-ai/cordis';

import { createMcpToolCollection } from '../src/services/mcpToolCollection';
const toolContexts: Context[] = [];
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';
import { createDoomToolSurface, type DoomToolSurfaceService } from '@agimon-ai/doompi-core/toolSurface';
import type { McpOutputSchemaWarning, McpServerStateChange } from '@agimon-ai/mcp-proxy';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMcpServerRoot } from '../src/extensions/workspaces/sessions/(backend)/_lib/serverRoot';
import { SESSION_ENV_VAR } from '../src/schemas/sessionConfig';
import { McpSession, type McpSessionOptions } from '../src/services/mcpSession';
import type { McpSessionConfig } from '../src/types/mcpConfig';

const createProxyContainer = vi.fn();

vi.mock('@agimon-ai/mcp-proxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agimon-ai/mcp-proxy')>()),
  createProxyContainer: (...args: unknown[]) => createProxyContainer(...args),
}));

let repoRoot: string;
let emitState: (change: McpServerStateChange) => void;
let listTools: ReturnType<typeof vi.fn>;
let listResources: ReturnType<typeof vi.fn>;
let disconnectServer: ReturnType<typeof vi.fn>;
let ensureConnected: ReturnType<typeof vi.fn>;
let callTool: ReturnType<typeof vi.fn>;
let runtimeDisposals: Array<ReturnType<typeof vi.fn>>;
let surfaces: DoomToolSurfaceService[];

/** What Pi owns before any extension loads, so the surface knows the name exists. */
const BUILTIN_TOOLS = ['read'];

function fakePi() {
  const registered: string[] = [];
  const definitions = new Map<
    string,
    { name: string; execute?: (toolCallId: string, params: unknown) => Promise<unknown> }
  >();
  let active: string[] = [...BUILTIN_TOOLS];
  const pi = {
    on: vi.fn(),
    registerTool: vi.fn(
      (definition: { name: string; execute?: (toolCallId: string, params: unknown) => Promise<unknown> }) => {
        registered.push(definition.name);
        definitions.set(definition.name, definition);
      },
    ),
    getActiveTools: vi.fn(() => [...active]),
    // The inventory the surface recomputes from: built-ins plus everything
    // registered, whether or not it is currently visible.
    getAllTools: vi.fn(() => [...BUILTIN_TOOLS, ...registered].map((name) => ({ name }))),
    setActiveTools: vi.fn((names: string[]) => {
      active = [...names];
    }),
  } as unknown as ExtensionAPI;
  return { pi, registered, definitions, activeTools: () => active };
}

function writeRepoConfig(servers: Record<string, unknown>): void {
  fs.writeFileSync(path.join(repoRoot, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
}

function configuration(overrides: Partial<McpSessionConfig> = {}): McpSessionConfig {
  return {
    repoRoot,
    stagingDirectory: path.join(repoRoot, '.staging'),
    ...overrides,
  };
}

async function newSession(pi: ExtensionAPI, options: Partial<McpSessionOptions> = {}): Promise<McpSession> {
  const active = new McpSession({
    environment: { [SESSION_ENV_VAR]: JSON.stringify({ repoRoot, stagingDirectory: path.join(repoRoot, '.staging') }) },
    tokenStore: { read: vi.fn(), write: vi.fn(), clear: vi.fn() },
    ...options,
  });
  const context = new Context();
  toolContexts.push(context);
  await definePiExtension({ name: '@test/mcp-tools', tools: createMcpToolCollection(active) }).install(context, pi);
  return active;
}

/** The one arbiter of this host's active list, as the session fiber provides it. */
function toolSurfaceFor(pi: ExtensionAPI): DoomToolSurfaceService {
  const surface = createDoomToolSurface({
    generation: 'mcp-session-test',
    allTools: () => pi.getAllTools().map((tool) => tool.name),
    activeTools: () => pi.getActiveTools(),
    setActiveTools: (names) => pi.setActiveTools([...names]),
  });
  surfaces.push(surface);
  return surface;
}

/** A session already bound to its own tool surface, as the session fiber binds it. */
async function sessionWithSurface(
  pi: ExtensionAPI,
  options: Partial<McpSessionOptions> = {},
): Promise<{
  active: McpSession;
  surface: DoomToolSurfaceService;
  unbind: () => void;
}> {
  const active = await newSession(pi, options);
  const surface = toolSurfaceFor(pi);
  const unbind = active.bindToolSurface(surface);
  return { active, surface, unbind };
}

async function session(pi: ExtensionAPI, options: Partial<McpSessionOptions> = {}): Promise<McpSession> {
  return (await sessionWithSurface(pi, options)).active;
}

beforeEach(() => {
  vi.clearAllMocks();
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-mcp-session-'));
  writeRepoConfig({ pencil: { type: 'stdio', command: 'pencil' } });
  listTools = vi.fn().mockResolvedValue([{ name: 'get_screenshot', inputSchema: { type: 'object' } }]);
  listResources = vi.fn().mockResolvedValue([{ uri: 'pencil://canvas', name: 'canvas' }]);
  disconnectServer = vi.fn().mockResolvedValue(undefined);
  // The manager announces `connected` before it registers the client, so the tool
  // read has to go through ensureConnected; getClient would still be empty.
  callTool = vi.fn();
  ensureConnected = vi.fn().mockResolvedValue({ callTool, listTools, listResources });
  runtimeDisposals = [];
  surfaces = [];

  createProxyContainer.mockImplementation(() => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    runtimeDisposals.push(dispose);
    return Promise.resolve({
      clientManager: {
        onServerStateChange: (listener: (change: McpServerStateChange) => void) => {
          emitState = listener;
          return () => undefined;
        },
        getClient: () => undefined,
        disconnectServer,
        ensureConnected,
        getServerRequestTimeout: () => 500,
      },
      connectionsSettled: Promise.resolve(),
      dispose,
    });
  });
});

afterEach(async () => {
  await Promise.all(toolContexts.splice(0).map((context) => context.fiber.dispose()));
  for (const surface of surfaces) surface.dispose();
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('McpSession', () => {
  it('refreshes metadata without changing the registered input identity', async () => {
    const { pi, registered } = fakePi();
    const active = await session(pi);
    active.install();
    await active.start();
    emitState({ serverName: 'pencil', state: 'connected' });
    await vi.waitFor(() => expect(active.activeToolDefinitions()).toHaveLength(1));
    const input = {
      name: 'get_screenshot',
      inputSchema: { type: 'object' },
      annotations: { readOnlyHint: true },
      outputSchema: { type: 'object', properties: { count: { type: 'number' } } },
    };
    listTools.mockResolvedValue([input]);
    emitState({ serverName: 'pencil', state: 'connected' });
    await vi.waitFor(() =>
      expect(active.activeToolDefinitions()[0]).toMatchObject({
        annotations: input.annotations,
        outputSchema: input.outputSchema,
      }),
    );
    expect(registered).toEqual(['pencil_get_screenshot']);
    expect(active.getDiagnostics()).toEqual([]);
    callTool.mockResolvedValue({ content: [], structuredContent: { count: 1 }, isError: false });
    await expect(active.invokeTool('pencil_get_screenshot', {})).resolves.toMatchObject({
      content: [{ type: 'text', text: '{"count":1}' }],
      structuredContent: { count: 1 },
      isError: false,
    });
    await active.dispose();
  });

  describe('install', () => {
    it('reports the configured servers before anything has connected', async () => {
      const { pi } = fakePi();

      expect((await session(pi)).install()).toEqual({
        servers: [{ name: 'pencil', state: 'not-connected', tools: [], resourceCount: 0 }],
      });
    });

    it('does not build a container', async () => {
      const { pi } = fakePi();

      (await session(pi)).install();

      expect(createProxyContainer).not.toHaveBeenCalled();
    });

    it('exposes proxy upstreams as their actual MCP servers', async () => {
      writeRepoConfig({
        'mcp-proxy': {
          type: 'stdio',
          command: 'npx',
          args: ['mcp-serve', '--config', './mcp-config.yaml'],
        },
        pencil: { type: 'stdio', command: 'pencil' },
      });
      fs.writeFileSync(
        path.join(repoRoot, 'mcp-config.yaml'),
        'mcpServers:\n  review-server:\n    command: reviewer\n  scaffold-mcp:\n    command: scaffold\n',
      );
      const { pi } = fakePi();

      expect((await session(pi)).install().servers.map((server) => server.name)).toEqual([
        'pencil',
        'review-server',
        'scaffold-mcp',
      ]);
    });
  });

  it('passes upstream config directly to the embedded client container', async () => {
    writeRepoConfig({
      'mcp-proxy': {
        type: 'stdio',
        command: 'npx',
        args: ['mcp-serve', '--config', './mcp-config.yaml'],
      },
    });
    const upstreamConfig = path.join(repoRoot, 'mcp-config.yaml');
    fs.writeFileSync(upstreamConfig, 'mcpServers:\n  review-server:\n    command: reviewer\n');
    const { pi } = fakePi();
    const active = await session(pi);
    active.install();

    await active.start();

    expect(createProxyContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        configSources: expect.arrayContaining([{ path: upstreamConfig, format: 'claude' }]),
      }),
    );
    expect(createProxyContainer.mock.calls[0]?.[0]?.configSources).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: expect.stringContaining('shared-') })]),
    );
  });

  it('keeps output warnings non-blocking, bounded, deduplicated and scoped to the live session', async () => {
    const { pi, activeTools } = fakePi();
    const active = await session(pi);
    active.install();
    await active.start();
    const validation = createProxyContainer.mock.calls[0]?.[0].outputSchemaValidation as {
      mode: string;
      onWarning: (warning: McpOutputSchemaWarning) => void;
    };
    expect(validation.mode).toBe('warn');
    const warning: McpOutputSchemaWarning = {
      serverName: 'pencil',
      toolName: 'get_screenshot',
      method: 'tools/list',
      path: 'outputSchema.type',
      message: 'Expected an object output schema.',
    };
    validation.onWarning(warning);
    validation.onWarning(warning);
    emitState({ serverName: 'pencil', state: 'connected' });
    await vi.waitFor(() => expect(activeTools()).toContain('pencil_get_screenshot'));
    expect(active.getToolWarnings()).toEqual({
      mcp_use: [{ source: 'pencil/get_screenshot (tools/list)', path: warning.path, message: warning.message }],
      pencil_get_screenshot: [
        { source: 'pencil/get_screenshot (tools/list)', path: warning.path, message: warning.message },
      ],
    });
    const output = { content: [{ type: 'text', text: 'actual output' }] };
    callTool.mockImplementationOnce(async () => {
      validation.onWarning({ ...warning, method: 'tools/call', path: 'structuredContent' });
      return output;
    });
    await expect(active.invokeTool('pencil_get_screenshot', {})).resolves.toMatchObject(output);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(active.getToolWarnings().mcp_use).toHaveLength(2);
    callTool.mockResolvedValue(output);
    await active.invokeTool('pencil_get_screenshot', {});
    expect(active.getToolWarnings().mcp_use).toHaveLength(1);
    for (let i = 0; i < 100; i++) validation.onWarning({ ...warning, path: `outputSchema.properties.field${i}` });
    expect(active.getToolWarnings().mcp_use).toHaveLength(64);
    expect(active.getSnapshot().servers[0]?.error).toBeUndefined();
    expect(active.getDiagnostics()).toEqual([]);
    await active.disconnect('pencil');
    validation.onWarning(warning);
    expect(active.getToolWarnings()).toEqual({});
    await active.start();
    validation.onWarning(warning);
    expect(active.getToolWarnings()).toEqual({});
    await active.dispose();
    expect(active.getToolWarnings()).toEqual({});
  });

  it('replaces the container when the exact session cwd changes under the same MCP projection', async () => {
    const { pi } = fakePi();
    const active = await session(pi);
    const config = configuration();
    const firstCwd = path.join(repoRoot, 'first');
    const secondCwd = path.join(repoRoot, 'second');

    await active.reconfigure(config, firstCwd);
    await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledTimes(1));
    await active.reconfigure(config, secondCwd);
    await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledTimes(2));
    expect(createProxyContainer.mock.calls.map(([options]) => options.executionCwd)).toEqual([firstCwd, secondCwd]);
    expect(createProxyContainer.mock.calls.map(([options]) => options.workspaceRoot)).toEqual([repoRoot, repoRoot]);
    await active.dispose();
  });

  describe('session-only disconnect', () => {
    it('closes the connection, deactivates tools, keeps credentials and allows reauthorization', async () => {
      const { pi, activeTools, definitions } = fakePi();
      const active = await session(pi);
      active.install();
      await active.start();
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(activeTools()).toContain('pencil_get_screenshot'));
      await active.disconnect('pencil');
      expect(disconnectServer).toHaveBeenCalledWith('pencil');
      expect(active.getSnapshot().servers[0]?.state).toBe('closed');
      expect(activeTools()).toEqual(['read']);
      const store = createProxyContainer.mock.calls[0]?.[0]?.auth.tokenStore;
      expect(store.clear).not.toHaveBeenCalled();
      expect(store.write).not.toHaveBeenCalled();
      ensureConnected.mockClear();
      await expect(active.listResources('pencil')).rejects.toThrow('disconnected');
      await expect(definitions.get('pencil_get_screenshot')?.execute?.('stale-call', {})).rejects.toThrow(
        'unavailable in this plugin generation',
      );
      expect(ensureConnected).not.toHaveBeenCalled();
      await active.reauthorize('pencil');
      expect(store.clear).toHaveBeenCalledWith('pencil');
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(activeTools()).toContain('pencil_get_screenshot'));
    });

    it('ignores late tool discovery and connection events after disconnect', async () => {
      const { pi, activeTools } = fakePi();
      const active = await session(pi);
      active.install();
      await active.start();
      let finishDiscovery: (tools: never[]) => void = () => undefined;
      const discovery = new Promise<never[]>((resolve) => {
        finishDiscovery = resolve;
      });
      listTools.mockReturnValue(discovery);
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(listTools).toHaveBeenCalledOnce());
      await active.disconnect('pencil');
      finishDiscovery([]);
      await discovery;
      await Promise.resolve();
      emitState({ serverName: 'pencil', state: 'connected' });
      expect(active.getSnapshot().servers[0]?.state).toBe('closed');
      expect(activeTools()).toEqual(['read']);
      expect(listTools).toHaveBeenCalledOnce();
    });

    it('reports disconnect failures without marking the server closed', async () => {
      const { pi } = fakePi();
      const active = await session(pi);
      active.install();
      await expect(active.disconnect('missing')).rejects.toThrow('Unknown MCP server');
      await expect(active.disconnect('pencil')).rejects.toThrow();
      await active.start();
      disconnectServer.mockRejectedValueOnce(new Error('close failed'));
      await expect(active.disconnect('pencil')).rejects.toThrow('close failed');
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(active.getSnapshot().servers[0]?.state).toBe('connected'));
    });
  });

  describe('folding in a server as it connects', () => {
    it('restores the original declaration after a connection failure without registering it twice', async () => {
      const { pi, registered, definitions, activeTools } = fakePi();
      const active = await session(pi);
      active.install();
      await active.start();
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(activeTools()).toContain('pencil_get_screenshot'));
      const original = definitions.get('pencil_get_screenshot');

      emitState({ serverName: 'pencil', state: 'failed', error: 'connection lost' });
      await vi.waitFor(() => expect(activeTools()).not.toContain('pencil_get_screenshot'));

      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(activeTools()).toContain('pencil_get_screenshot'));
      expect(definitions.get('pencil_get_screenshot')).toBe(original);
      expect(registered).toEqual(['pencil_get_screenshot']);
    });

    it('registers and activates its tools', async () => {
      const { pi, registered, activeTools } = fakePi();
      const active = await session(pi);
      active.install();
      await active.start();

      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(registered).toEqual(['pencil_get_screenshot']));

      expect(activeTools()).toEqual(['read', 'pencil_get_screenshot']);
      expect(active.getSnapshot().servers[0]).toMatchObject({ state: 'connected', tools: ['pencil_get_screenshot'] });
    });

    it('records a failure without asking the server for tools', async () => {
      const { pi, activeTools } = fakePi();
      const active = await session(pi);
      active.install();
      await active.start();

      emitState({ serverName: 'pencil', state: 'failed', error: 'spawn ENOENT' });
      await vi.waitFor(() => expect(active.getSnapshot().servers[0].state).toBe('failed'));

      expect(listTools).not.toHaveBeenCalled();
      expect(activeTools()).toEqual(['read']);
    });

    it.each(['ensureConnected', 'listTools'] as const)(
      'records safe discovery errors from %s and recovers',
      async (operation) => {
        const failing = operation === 'ensureConnected' ? ensureConnected : listTools;
        failing.mockRejectedValue(new Error('secret-token https://private.example'));
        const { pi, activeTools } = fakePi();
        const active = await session(pi);
        active.install();
        await active.start();
        const message = 'Could not discover tools for MCP server "pencil".';
        emitState({ serverName: 'pencil', state: 'connected' });
        await vi.waitFor(() => expect(active.getServers()[0].error).toBe(message));
        expect(active.getSnapshot().servers[0]).toMatchObject({ state: 'connected', tools: [] });
        expect(active.getDiagnostics()).toEqual([message]);
        expect(activeTools()).toEqual(['read']);
        const listener = vi.fn();
        active.onChange(listener);
        emitState({ serverName: 'pencil', state: 'connected' });
        await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
        expect(active.getDiagnostics()).toEqual([message]);
        ensureConnected.mockResolvedValue({ callTool, listTools, listResources });
        listTools.mockResolvedValue([{ name: 'get_screenshot', inputSchema: { type: 'object' } }]);
        emitState({ serverName: 'pencil', state: 'connected' });
        await vi.waitFor(() => expect(activeTools()).toContain('pencil_get_screenshot'));
        expect(active.getServers()[0].error).toBeUndefined();
      },
    );

    it('accepts successful empty discovery and clears a previous error', async () => {
      const active = await session(fakePi().pi);
      active.install();
      await active.start();
      listTools.mockResolvedValue([]);
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(active.getServers()[0].state).toBe('connected'));
      expect(active.getServers()[0].error).toBeUndefined();
      expect(active.getDiagnostics()).toEqual([]);
      listTools.mockRejectedValueOnce(new Error('sensitive'));
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(active.getServers()[0].error).toBeDefined());
      listTools.mockResolvedValue([]);
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(active.getServers()[0].error).toBeUndefined());
      expect(active.getSnapshot().servers[0]).toMatchObject({ state: 'connected', tools: [] });
      expect(active.getDiagnostics()).toHaveLength(1);
    });

    it.each(['disconnect', 'restart', 'dispose'] as const)(
      'ignores rejected discovery after %s',
      async (retirement) => {
        const { pi, registered } = fakePi();
        const active = await session(pi);
        active.install();
        await active.start();
        let reject!: (error: Error) => void;
        listTools.mockReturnValueOnce(
          new Promise((_, rejectDiscovery) => {
            reject = rejectDiscovery;
          }),
        );
        emitState({ serverName: 'pencil', state: 'connected' });
        await vi.waitFor(() => expect(listTools).toHaveBeenCalledOnce());
        if (retirement === 'disconnect') await active.disconnect('pencil');
        else if (retirement === 'restart') await active.start();
        else await active.dispose();
        const snapshot = active.getSnapshot();
        const listener = vi.fn();
        active.onChange(listener);
        reject(new Error('sensitive stale failure'));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(active.getSnapshot()).toEqual(snapshot);
        expect(active.getDiagnostics()).toEqual([]);
        expect(listener).not.toHaveBeenCalled();
        expect(registered).toEqual([]);
      },
    );

    // A `/domains` switch replaces the runtime; a change from the old one must not
    // write tools into the new session.
    it('ignores a change from a container that is no longer live', async () => {
      const { pi, registered } = fakePi();
      const active = await session(pi);
      active.install();
      await active.start();
      const staleEmit = emitState;

      await active.start();
      staleEmit({ serverName: 'pencil', state: 'connected' });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(registered).toEqual([]);
    });
  });

  describe('reconfigure', () => {
    it('returns early for an unchanged fingerprint without rebuilding or re-registering', async () => {
      const { pi, registered } = fakePi();
      const active = await session(pi);
      active.install(configuration({ allowlist: { servers: ['pencil', 'boomlink'] } }));
      await active.start();

      await active.reconfigure(configuration({ allowlist: { servers: ['boomlink', 'pencil'] } }));

      expect(createProxyContainer).toHaveBeenCalledOnce();
      expect(registered).toEqual([]);
    });

    it('rebuilds sources and allowlists while retiring the old runtime', async () => {
      const pluginConfig = path.join(repoRoot, 'design.mcp.json');
      fs.writeFileSync(pluginConfig, JSON.stringify({ mcpServers: { figma: { command: 'figma' } } }));
      const { pi, activeTools } = fakePi();
      const active = await session(pi);
      active.install(configuration());
      await active.start();

      await active.reconfigure(
        configuration({
          generatedConfigPath: path.join(repoRoot, 'domain-mcp.json'),
          pluginConfigPaths: [pluginConfig],
          allowlist: { servers: ['figma'] },
        }),
      );

      expect(active.getSnapshot().servers.map((server) => server.name)).toEqual(['figma']);
      expect(activeTools()).toEqual(['read']);
      expect(runtimeDisposals[0]).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledTimes(2));
    });

    it('deactivates removed wrappers and registers each newly selected tool once', async () => {
      const { pi, registered, activeTools } = fakePi();
      const active = await session(pi);
      active.install(configuration());
      await active.start();
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(activeTools()).toEqual(['read', 'pencil_get_screenshot']));

      writeRepoConfig({ boomlink: { type: 'stdio', command: 'boomlink' } });
      listTools.mockResolvedValue([{ name: 'search', inputSchema: { type: 'object' } }]);
      await active.reconfigure(configuration({ generatedConfigPath: path.join(repoRoot, 'domain-mcp.json') }));
      expect(activeTools()).toEqual(['read']);
      await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledTimes(2));
      emitState({ serverName: 'boomlink', state: 'connected' });
      await vi.waitFor(() => expect(activeTools()).toEqual(['read', 'boomlink_search']));

      expect(registered).toEqual(['pencil_get_screenshot', 'boomlink_search']);
    });

    it('hides incompatible schema reuse and makes the retained wrapper fail closed', async () => {
      const { pi, registered, definitions, activeTools } = fakePi();
      const active = await session(pi);
      active.install(configuration());
      await active.start();
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(registered).toEqual(['pencil_get_screenshot']));

      listTools.mockResolvedValue([
        {
          name: 'get_screenshot',
          inputSchema: { type: 'object', properties: { format: { type: 'string' } } },
        },
      ]);
      await active.reconfigure(configuration({ generatedConfigPath: path.join(repoRoot, 'domain-mcp.json') }));
      await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledTimes(2));
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(active.getDiagnostics()).toEqual([expect.stringContaining('relaunched')]));

      expect(registered).toEqual(['pencil_get_screenshot']);
      expect(activeTools()).toEqual(['read']);
      await expect(definitions.get('pencil_get_screenshot')?.execute?.('call-1', {})).rejects.toThrow(
        'unavailable in this plugin generation',
      );
    });

    it('rejects authorization callbacks from a retired generation', async () => {
      const { pi } = fakePi();
      const active = await session(pi);
      active.install(configuration());
      await active.start();
      const staleAuthorization = createProxyContainer.mock.calls[0]?.[0]?.auth?.onAuthorizationUrl as
        | ((url: URL, serverName: string) => void)
        | undefined;

      await active.reconfigure(configuration({ generatedConfigPath: path.join(repoRoot, 'domain-mcp.json') }));
      staleAuthorization?.(new URL('https://example.test/authorize'), 'pencil');

      await expect(active.openAuthorizationPage('pencil')).rejects.toThrow('No authorization page');
    });
  });

  describe('reauthorize', () => {
    it('drops the connection and stale OAuth registration before reconnecting', async () => {
      const { pi } = fakePi();
      const active = await session(pi);
      active.install();
      await active.start();
      const store = createProxyContainer.mock.calls[0]?.[0]?.auth.tokenStore;

      await active.reauthorize('boomlink');

      expect(disconnectServer).toHaveBeenCalledWith('boomlink');
      expect(store.clear).toHaveBeenCalledWith('boomlink');
      expect(ensureConnected).toHaveBeenCalledWith('boomlink');
      expect(disconnectServer.mock.invocationCallOrder[0]).toBeLessThan(store.clear.mock.invocationCallOrder[0]);
      expect(store.clear.mock.invocationCallOrder[0]).toBeLessThan(ensureConnected.mock.invocationCallOrder[0]);
    });

    it('does not clear credentials or reconnect after a domain switch during disconnect', async () => {
      const active = await session(fakePi().pi);
      active.install();
      await active.start();
      const store = createProxyContainer.mock.calls[0]?.[0]?.auth.tokenStore;
      let release!: () => void;
      disconnectServer.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));

      const authorization = active.reauthorize('pencil');
      await active.reconfigure(configuration({ enabled: false }));
      release();
      await authorization;

      expect(store.clear).not.toHaveBeenCalled();
      expect(ensureConnected).not.toHaveBeenCalled();
    });

    it('does not deliver a queued OAuth URL to a retired session', async () => {
      const onAuthorizationUrl = vi.fn();
      const active = new McpSession({
        onAuthorizationUrl,
        tokenStore: { read: vi.fn(), write: vi.fn(), clear: vi.fn() },
      });
      active.install(configuration());
      await active.start();
      const authorize = createProxyContainer.mock.calls[0]?.[0]?.auth?.onAuthorizationUrl;
      authorize(new URL('https://auth.example.test/waiting'), 'pencil');
      await active.reconfigure(configuration({ enabled: false }));

      expect(onAuthorizationUrl).not.toHaveBeenCalled();
    });

    it('clears the previous URL before retry even when disconnect rejects without a state event', async () => {
      const active = await session(fakePi().pi);
      active.install();
      await active.start();
      const authorize = createProxyContainer.mock.calls[0]?.[0]?.auth?.onAuthorizationUrl;
      authorize(new URL('https://auth.example.test/old'), 'pencil');
      const listener = vi.fn();
      active.onChange(listener);
      disconnectServer.mockImplementation(async () => {
        expect(active.getServers()[0].authorizationUrl).toBeUndefined();
        throw new Error('disconnect failed');
      });
      await expect(active.reauthorize('pencil')).rejects.toThrow('disconnect failed');
      expect(listener).toHaveBeenCalledOnce();
    });

    it.each(['connected', 'failed', 'closed', 'degraded'] as const)(
      'retains URLs while needs-auth is waiting and clears them on %s',
      async (state) => {
        const hostCallback = vi.fn().mockRejectedValue(new Error('browser unavailable'));
        const active = new McpSession({
          onAuthorizationUrl: hostCallback,
          tokenStore: { read: vi.fn(), write: vi.fn(), clear: vi.fn() },
        });
        active.install(configuration());
        await active.start();
        const authorize = createProxyContainer.mock.calls[0]?.[0]?.auth?.onAuthorizationUrl;
        const url = new URL('https://auth.example.test/waiting');
        authorize(url, 'pencil');
        emitState({ serverName: 'pencil', state: 'needs-auth' });
        await vi.waitFor(() => expect(active.getServers()[0].state).toBe('needs-auth'));
        await vi.waitFor(() => expect(active.getDiagnostics().join()).toContain('browser unavailable'));
        expect(active.getServers()[0].authorizationUrl).toBe(url.toString());
        emitState({ serverName: 'pencil', state });
        await vi.waitFor(() => expect(active.getServers()[0].state).toBe(state));
        expect(active.getServers()[0].authorizationUrl).toBeUndefined();
      },
    );

    it('says so when the runtime has not started', async () => {
      const { pi } = fakePi();

      await expect((await session(pi)).reauthorize('boomlink')).rejects.toThrow('has not started yet');
    });
  });

  describe('enabling and disabling', () => {
    async function connectedSession() {
      const fake = fakePi();
      const active = await session(fake.pi);
      active.install();
      await active.start();
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(fake.activeTools()).toEqual(['read', 'pencil_get_screenshot']));
      return { ...fake, active };
    }

    it('withholds a disabled server tools while leaving the rest of Pi alone', async () => {
      const { active, activeTools } = await connectedSession();

      active.setEnabled('pencil', false);

      expect(activeTools()).toEqual(['read']);
      expect(active.activeToolDefinitions()).toEqual([]);
    });

    it('restores them on the way back without re-registering anything', async () => {
      const { active, activeTools, registered } = await connectedSession();
      active.setEnabled('pencil', false);

      active.setEnabled('pencil', true);

      expect(activeTools()).toEqual(['read', 'pencil_get_screenshot']);
      expect(registered).toEqual(['pencil_get_screenshot']);
    });

    // Disable is a reversible session visibility control; authorization and the
    // live connection stay warm for an instant enable.
    it('never drops the connection', async () => {
      const { active } = await connectedSession();

      active.setEnabled('pencil', false);

      expect(disconnectServer).not.toHaveBeenCalled();
    });
  });

  describe('remote tool invocations', () => {
    it('calls the active tool through the live session runtime', async () => {
      const { pi } = fakePi();
      const active = await session(pi);
      active.install();
      await active.start();
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(active.activeToolDefinitions()).toHaveLength(1));
      callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

      await expect(active.invokeTool('pencil_get_screenshot', { quality: 'full' })).resolves.toEqual({
        content: [{ type: 'text', text: 'ok' }],
        details: { server: 'pencil', tool: 'get_screenshot' },
      });
      expect(callTool).toHaveBeenCalledWith(
        'get_screenshot',
        { quality: 'full' },
        { timeout: 500, onResult: expect.any(Function) },
      );
    });

    describe('file parameters', () => {
      const uploadTool = {
        name: 'get_screenshot',
        inputSchema: { type: 'object', properties: { image: { type: 'object' }, note: { type: 'string' } } },
        _meta: { 'openai/fileParams': ['image'] },
      };
      const shared = {
        url: `https://tunnel.example/mcp-file/${'a'.repeat(43)}`,
        fileName: 'shot.png',
        mimeType: 'image/png',
        size: 3,
        revoke: vi.fn(),
      };

      async function fileSession(publishFile?: McpSessionOptions['publishFile']) {
        listTools.mockResolvedValue([uploadTool]);
        const active = await session(fakePi().pi, publishFile === undefined ? {} : { publishFile });
        active.install();
        await active.start();
        emitState({ serverName: 'pencil', state: 'connected' });
        await vi.waitFor(() => expect(active.activeToolDefinitions()[0]?._meta).toBeDefined());
        ensureConnected.mockClear();
        return active;
      }

      it('sends the published file and revokes it once the call settles', async () => {
        const publishFile = vi.fn().mockResolvedValue(shared);
        const active = await fileSession(publishFile);
        callTool.mockImplementation(async () => {
          expect(shared.revoke).not.toHaveBeenCalled();
          return { content: [{ type: 'text', text: 'ok' }] };
        });
        const parameters = { image: { path: 'shots/shot.png' }, note: 'hi' };

        await active.invokeTool('pencil_get_screenshot', parameters);

        expect(publishFile).toHaveBeenCalledExactlyOnceWith(
          'shots/shot.png',
          expect.objectContaining({ serverName: 'pencil', toolName: 'get_screenshot' }),
          undefined,
        );
        expect(callTool).toHaveBeenCalledWith(
          'get_screenshot',
          {
            image: {
              file_id: expect.stringMatching(/^doomfile_/u),
              download_url: shared.url,
              file_name: 'shot.png',
              mime_type: 'image/png',
            },
            note: 'hi',
          },
          expect.objectContaining({ timeout: 500 }),
        );
        expect(parameters).toEqual({ image: { path: 'shots/shot.png' }, note: 'hi' });
        expect(shared.revoke).toHaveBeenCalledOnce();
      });

      it('revokes the link when the server call fails', async () => {
        const active = await fileSession(vi.fn().mockResolvedValue(shared));
        callTool.mockRejectedValue(new Error('upstream down'));

        await expect(active.invokeTool('pencil_get_screenshot', { image: { path: 'shot.png' } })).rejects.toThrow(
          'upstream down',
        );
        expect(shared.revoke).toHaveBeenCalledOnce();
      });

      it('revokes the link once when the server cannot be reached after the share', async () => {
        const active = await fileSession(vi.fn().mockResolvedValue(shared));
        ensureConnected.mockRejectedValue(new Error('pencil unreachable'));

        await expect(active.invokeTool('pencil_get_screenshot', { image: { path: 'shot.png' } })).rejects.toThrow(
          'pencil unreachable',
        );
        expect(shared.revoke).toHaveBeenCalledOnce();
        expect(callTool).not.toHaveBeenCalled();
      });

      describe('through the server root publisher', () => {
        /** A session from createMcpServerRoot, so the file publisher is the one the root wires in. */
        async function rootFileSession(agent?: { request: ReturnType<typeof vi.fn> }) {
          listTools.mockResolvedValue([uploadTool]);
          const shareFile = vi.fn().mockResolvedValue(shared);
          const appendCustomEntry = vi.fn().mockResolvedValue(undefined);
          const root = createMcpServerRoot({
            host: { context: { shareFile } },
            ...(agent === undefined
              ? {}
              : { agent: { context: { client: { request: agent.request }, session: { appendCustomEntry } } } }),
            signal: new AbortController().signal,
          } as unknown as DoomServerPluginContext);
          const active = root.value.session;
          active.install(configuration());
          await active.start();
          emitState({ serverName: 'pencil', state: 'connected' });
          await vi.waitFor(() => expect(active.activeToolDefinitions()[0]?._meta).toBeDefined());
          ensureConnected.mockClear();
          return { active, shareFile, appendCustomEntry };
        }

        it('asks the user before the server sees the published file, then revokes it', async () => {
          const request = vi.fn().mockResolvedValue(true);
          const { active, shareFile, appendCustomEntry } = await rootFileSession({ request });
          callTool.mockImplementation(async () => {
            expect(request).toHaveBeenCalledOnce();
            expect(shared.revoke).not.toHaveBeenCalled();
            return { content: [{ type: 'text', text: 'ok' }] };
          });

          await active.invokeTool('pencil_get_screenshot', { image: { path: 'shots/shot.png' } });

          expect(shareFile).toHaveBeenCalledExactlyOnceWith('shots/shot.png', 'pencil / get_screenshot');
          expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'confirm' }), expect.any(AbortSignal));
          expect(appendCustomEntry).toHaveBeenCalledWith(
            'mcp.file.share',
            expect.objectContaining({ outcome: 'shared' }),
          );
          expect(callTool).toHaveBeenCalledWith(
            'get_screenshot',
            { image: expect.objectContaining({ download_url: shared.url, file_name: 'shot.png' }) },
            expect.anything(),
          );
          expect(shared.revoke).toHaveBeenCalledOnce();
        });

        it('fails closed without a client to approve the share', async () => {
          const { active, shareFile } = await rootFileSession();

          await expect(active.invokeTool('pencil_get_screenshot', { image: { path: 'shot.png' } })).rejects.toThrow(
            'There is no DoomPi client to approve sharing "shot.png".',
          );
          expect(shareFile).toHaveBeenCalledOnce();
          expect(shared.revoke).toHaveBeenCalledOnce();
          expect(ensureConnected).not.toHaveBeenCalled();
          expect(callTool).not.toHaveBeenCalled();
        });
      });

      it.each([
        ['a refused share', new Error('Remote access is off')],
        ['a declined consent', new Error('The user declined to share "shot.png".')],
      ])('never dials the server after %s', async (_label, error) => {
        const active = await fileSession(vi.fn().mockRejectedValue(error));

        await expect(active.invokeTool('pencil_get_screenshot', { image: { path: 'shot.png' } })).rejects.toThrow(
          error.message,
        );
        expect(ensureConnected).not.toHaveBeenCalled();
        expect(callTool).not.toHaveBeenCalled();
      });

      it('refuses a file without a publisher before dialing the server', async () => {
        const active = await fileSession();

        await expect(active.invokeTool('pencil_get_screenshot', { image: { path: 'shot.png' } })).rejects.toThrow(
          'needs the DoomPi web host with remote access on',
        );
        expect(ensureConnected).not.toHaveBeenCalled();
      });

      it('leaves calls to tools without file parameters unchanged', async () => {
        listTools.mockResolvedValue([{ name: 'get_screenshot', inputSchema: { type: 'object' } }]);
        const publishFile = vi.fn();
        const active = await session(fakePi().pi, { publishFile });
        active.install();
        await active.start();
        emitState({ serverName: 'pencil', state: 'connected' });
        await vi.waitFor(() => expect(active.activeToolDefinitions()).toHaveLength(1));
        callTool.mockResolvedValue({ content: [] });

        await active.invokeTool('pencil_get_screenshot', { image: { path: 'shot.png' } });

        expect(publishFile).not.toHaveBeenCalled();
        expect(callTool).toHaveBeenCalledWith('get_screenshot', { image: { path: 'shot.png' } }, expect.anything());
      });
    });

    it('captures pre-guard component data and forwards cancellation while keeping the guarded result', async () => {
      const active = await session(fakePi().pi);
      active.install();
      await active.start();
      listTools.mockResolvedValue([
        { name: 'get_screenshot', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://canvas' } } },
      ]);
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(active.activeToolDefinitions()[0]?._meta).toBeDefined());
      const tool = active.activeToolDefinitions()[0];
      expect(tool).toBeDefined();
      if (!tool) return;
      const controller = new AbortController();
      const original = {
        content: [{ type: 'text' as const, text: 'raw' }],
        structuredContent: { privatePayload: 'x'.repeat(20_000) },
        _meta: { sentinel: 'private' },
      };
      callTool.mockImplementation(
        async (_name: string, _args: unknown, options: { onResult(value: typeof original): void }) => {
          options.onResult(original);
          return { content: [{ type: 'text', text: 'guard summary' }] };
        },
      );
      const result = await active.invokeTool(tool.piName, {}, controller.signal);
      expect(result.content).toEqual([{ type: 'text', text: 'guard summary' }]);
      expect(result.details).toMatchObject({ app: { resourceUri: 'ui://canvas', result: original } });
      expect(callTool).toHaveBeenCalledWith(
        'get_screenshot',
        {},
        expect.objectContaining({ signal: controller.signal, timeout: 500 }),
      );
    });

    it('reads only an advertised App resource and rejects a resource answer after runtime retirement', async () => {
      const active = await session(fakePi().pi);
      active.install();
      await active.start();
      listTools.mockResolvedValue([
        { name: 'get_screenshot', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://canvas' } } },
      ]);
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(active.activeToolDefinitions()[0]?._meta).toBeDefined());
      const resource = {
        contents: [{ uri: 'ui://canvas', mimeType: 'text/html;profile=mcp-app', text: '<p>App</p>' }],
      };
      const readResource = vi.fn().mockResolvedValue(resource);
      ensureConnected.mockResolvedValue({ callTool, listTools, listResources, readResource });
      const controller = new AbortController();
      await expect(active.readAppResource('pencil', 'get_screenshot', 'ui://other')).rejects.toThrow('not available');
      expect(readResource).not.toHaveBeenCalled();
      await expect(
        active.readAppResource('pencil', 'get_screenshot', 'ui://canvas', controller.signal),
      ).resolves.toEqual(resource);
      expect(readResource).toHaveBeenCalledWith('ui://canvas', { signal: controller.signal, timeout: 500 });
      let release: (value: typeof resource) => void = () => {
        throw new Error('Read has not started');
      };
      readResource.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const pending = active.readAppResource('pencil', 'get_screenshot', 'ui://canvas');
      await vi.waitFor(() => expect(readResource).toHaveBeenCalledTimes(2));
      await active.dispose();
      release(resource);
      await expect(pending).rejects.toThrow('retired MCP runtime');
    });

    it('rejects tools outside the current session configuration', async () => {
      const active = await session(fakePi().pi);

      await expect(active.invokeTool('missing', {})).rejects.toThrow(
        'not available in the current session configuration',
      );
    });
  });

  describe('the tool surface', () => {
    // MCP owns its wrappers and nothing else. The rival registers first, so a
    // restriction that rebuilt the list from the whole inventory instead of
    // filtering what it was handed would hand the rival's tool back.
    it('never restores a tool another owner is hiding', async () => {
      const fake = fakePi();
      const surface = toolSurfaceFor(fake.pi);
      const rival = surface.register({
        source: 'rival',
        restrict: (incoming) => incoming.filter((name) => name !== 'read'),
      });
      const active = await newSession(fake.pi);
      active.bindToolSurface(surface);
      active.install();
      await active.start();
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(fake.activeTools()).toEqual(['pencil_get_screenshot']));

      active.setEnabled('pencil', false);
      expect(fake.activeTools()).toEqual([]);
      active.setEnabled('pencil', true);
      expect(fake.activeTools()).toEqual(['pencil_get_screenshot']);

      rival.dispose();
      expect(fake.activeTools()).toEqual(['read', 'pencil_get_screenshot']);
    });

    // Nothing is snapshotted, so letting the restriction go is the whole restore.
    it('gives every wrapper back when the session unbinds', async () => {
      const fake = fakePi();
      const { active, unbind } = await sessionWithSurface(fake.pi);
      active.install();
      await active.start();
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(fake.activeTools()).toContain('pencil_get_screenshot'));
      active.setEnabled('pencil', false);
      expect(fake.activeTools()).toEqual(['read']);

      unbind();

      expect(fake.activeTools()).toEqual(['read', 'pencil_get_screenshot']);
    });
  });
  describe('listResources', () => {
    async function startedSession() {
      const { pi } = fakePi();
      const active = await session(pi);
      active.install();
      await active.start();
      return active;
    }

    it('lists a server resources once and serves the rest from cache', async () => {
      const active = await startedSession();

      expect(await active.listResources('pencil')).toEqual([{ uri: 'pencil://canvas', name: 'canvas' }]);
      await active.listResources('pencil');

      expect(listResources).toHaveBeenCalledTimes(1);
    });

    it('re-dials when asked to refresh', async () => {
      const active = await startedSession();
      await active.listResources('pencil');

      await active.listResources('pencil', { refresh: true });

      expect(listResources).toHaveBeenCalledTimes(2);
    });

    // A server without a resources capability rejects; remembering that as "none"
    // would make the pane permanently empty for the rest of the session.
    it('does not cache a failure', async () => {
      const active = await startedSession();
      listResources.mockRejectedValueOnce(new Error('method not found'));

      await expect(active.listResources('pencil')).rejects.toThrow('method not found');
      await active.listResources('pencil');

      expect(listResources).toHaveBeenCalledTimes(2);
    });

    it('counts them in the snapshot', async () => {
      const active = await startedSession();

      await active.listResources('pencil');

      expect(active.getSnapshot().servers[0].resourceCount).toBe(1);
    });

    it('says so when the runtime has not started', async () => {
      const { pi } = fakePi();

      await expect((await session(pi)).listResources('pencil')).rejects.toThrow('has not started yet');
    });

    it('forgets what it listed when the runtime is rebuilt', async () => {
      const active = await startedSession();
      await active.listResources('pencil');

      await active.start();
      await active.listResources('pencil');

      expect(listResources).toHaveBeenCalledTimes(2);
    });
  });

  describe('onChange', () => {
    it('announces a server folding in, and stops once disposed', async () => {
      const { pi } = fakePi();
      const active = await session(pi);
      const listener = vi.fn();
      active.install();
      await active.start();
      const unsubscribe = active.onChange(listener);

      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(listener).toHaveBeenCalled());
      unsubscribe();
      active.setEnabled('pencil', false);

      expect(listener).toHaveBeenCalledTimes(1);
    });

    // The emit runs inside the continuation that folds a server into Pi's tool set;
    // a listener throw escaping it would silently cost the session its tools.
    it('folds a server in even when a listener throws', async () => {
      const { pi, activeTools } = fakePi();
      const active = await session(pi);
      active.install();
      await active.start();
      active.onChange(() => {
        throw new Error('render failed');
      });

      emitState({ serverName: 'pencil', state: 'connected' });

      await vi.waitFor(() => expect(activeTools()).toEqual(['read', 'pencil_get_screenshot']));
    });

    it('reports a listener failure rather than dropping it', async () => {
      const { pi } = fakePi();
      const active = await session(pi);
      active.install();
      await active.start();
      active.onChange(() => {
        throw new Error('render failed');
      });

      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(active.getDiagnostics()).toHaveLength(1));

      expect(active.getDiagnostics()[0]).toContain('render failed');
    });

    // A fault that recurs on every repaint must not grow the list forever.
    it('records a repeated listener failure once', async () => {
      const { pi } = fakePi();
      const active = await session(pi);
      active.install();
      await active.start();
      active.onChange(() => {
        throw new Error('render failed');
      });

      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(active.getDiagnostics()).toHaveLength(1));
      active.setEnabled('pencil', false);
      active.setEnabled('pencil', true);

      expect(active.getDiagnostics()).toHaveLength(1);
    });
  });

  describe('dispose', () => {
    it('tears the container down', async () => {
      const { pi } = fakePi();
      const active = await session(pi);
      active.install();
      await active.start();

      await active.dispose();

      await expect(active.reauthorize('pencil')).rejects.toThrow('has not started yet');
    });
  });

  it('builds no container when the repository declares no servers', async () => {
    writeRepoConfig({});
    const { pi } = fakePi();
    const active = await session(pi);
    active.install();

    await active.start();

    expect(createProxyContainer).not.toHaveBeenCalled();
  });
});
