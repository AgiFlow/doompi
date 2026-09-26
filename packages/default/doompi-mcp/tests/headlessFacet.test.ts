import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHarnessSession } from '@agimon-ai/doompi-config/harnessStore';
import { DOOM_CHILD_SESSION_MCP_TOOL_SERVICE, type DoomChildSessionTool } from '@agimon-ai/doompi-core/childSession';
import {
  DOOM_HEADLESS_HOST_SERVICE,
  type DoomHeadlessActivity,
  type DoomHeadlessCommand,
  type DoomHeadlessExecutionContext,
  type DoomHeadlessHostService,
  type DoomHeadlessResource,
  type DoomHeadlessTool,
} from '@agimon-ai/doompi-core/headless';
import {
  DOOM_MCP_PROJECTION_RESOLVER_SERVICE,
  type DoomMcpProjection,
  type DoomMcpProjectionResolverService,
} from '@agimon-ai/doompi-core/mcpProjection';
import { DOOM_MCP_SESSION_ENV_VAR } from '@agimon-ai/doompi-core/mcpSession';
import { DOOM_MCP_STATUS_SERVICE, type DoomMcpStatusService } from '@agimon-ai/doompi-core/mcpStatus';
import { DOOM_SERVER_HOST_SERVICE } from '@agimon-ai/doompi-core/serverFacet';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { facet as mcpHeadlessFacet } from '../generated/server';
import sessionMcp from '../src/extensions/workspaces/sessions/(backend)/tool/session_mcp.mcp';
import type { McpRuntimeOptions } from '../src/services/mcpRuntime';
import { MCP_SESSION_TOOLS_SERVICE, type McpSessionToolsService } from '../src/services/mcpSessionTools';
import { sessionConfigEnvironment } from '../src/services/sessionConfig';
import { MCP_SESSION_AUTH_STATUS_KEY, parseMcpSessionAuthStatus } from '../src/types/webMcp';

const mock = vi.hoisted(() => ({
  start: vi.fn(),
  dispose: vi.fn(),
  ensureConnected: vi.fn(),
  disconnect: vi.fn(),
  callTool: vi.fn(),
  clearToken: vi.fn(),
  options: [] as McpRuntimeOptions[],
}));

vi.mock('../src/services/keyringTokenStore', () => ({
  createTokenStore: async () => ({ read: vi.fn(), write: vi.fn(), clear: mock.clearToken }),
}));
vi.mock('../src/services/mcpRuntime', () => ({
  readCachedCatalog: () => ({ servers: [] }),
  McpRuntimeOwner: class {
    private live = false;
    private readonly services = {
      clientManager: {
        ensureConnected: mock.ensureConnected,
        disconnectServer: mock.disconnect,
        getServerRequestTimeout: () => 500,
      },
    };
    async start(options: McpRuntimeOptions) {
      mock.options.push(options);
      await mock.start();
      this.live = true;
    }
    getServices() {
      return this.live ? this.services : undefined;
    }
    isCurrent(services: unknown) {
      return this.live && services === this.services;
    }
    async dispose() {
      this.live = false;
      await mock.dispose();
    }
  },
}));

const cleanups: Array<() => void | Promise<void>> = [];
let root: string;

beforeEach(() => {
  vi.clearAllMocks();
  mock.options.length = 0;
  mock.start.mockResolvedValue(undefined);
  mock.dispose.mockResolvedValue(undefined);
  mock.disconnect.mockResolvedValue(undefined);
  mock.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  mock.ensureConnected.mockResolvedValue({
    callTool: mock.callTool,
    listTools: async () => [{ name: 'ping', description: 'Ping upstream', inputSchema: { type: 'object' } }],
  });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-mcp-server-'));
  fs.writeFileSync(
    path.join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: { example: { command: 'unused-fixture' }, pending: { command: 'unused-fixture' } },
    }),
  );
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

async function setup(
  enabled = true,
  projection?: DoomMcpProjection,
  managed = false,
  cwd = root,
  resolver?: DoomMcpProjectionResolverService,
) {
  const statuses: Record<string, string> = {};
  const environment = sessionConfigEnvironment({
    enabled,
    repoRoot: root,
    stagingDirectory: path.join(root, 'staging'),
  });
  if (managed) delete environment[DOOM_MCP_SESSION_ENV_VAR];
  if (managed && projection)
    createHarnessSession(
      {
        root,
        majorMode: 'doom',
        domains: ['initial'],
        layers: [],
        profileEnvironment: {},
        skillDirectories: [],
        agentDirectories: [],
        additionalDirectories: [],
        childExtensions: [],
        pluginDirectories: [],
        pluginHooks: [],
        allowProtectedWrites: false,
        hooks: false,
        agents: false,
        mcp: enabled,
        mcpProjection: projection,
      },
      { directory: root, environment },
    );
  const execution = {
    cwd,
    repoRoot: root,
    sessionId: crypto.randomUUID(),
    selection: { majorMode: 'doom', activeLayers: [], domains: ['initial'] },
    environment,
    client: {
      notify: vi.fn(),
      request: vi.fn(),
      setStatus: vi.fn((key: string, value?: string) => {
        if (value === undefined) delete statuses[key];
        else statuses[key] = value;
      }),
    },
  } as unknown as DoomHeadlessExecutionContext;
  const resources: DoomHeadlessResource[] = [];
  const activities: DoomHeadlessActivity[] = [];
  const commands: DoomHeadlessCommand[] = [];
  const tools: DoomHeadlessTool[] = [];
  const registration = () => ({ dispose: vi.fn() });
  const selectionListeners = new Set<(selection: DoomHeadlessExecutionContext['selection']) => void | Promise<void>>();
  const host = {
    context: execution,
    subscribeSelection: (listener: (selection: DoomHeadlessExecutionContext['selection']) => void | Promise<void>) => {
      selectionListeners.add(listener);
      return () => selectionListeners.delete(listener);
    },
    registerResource: (value: DoomHeadlessResource) => {
      resources.push(value);
      return registration();
    },
    registerActivity: (value: DoomHeadlessActivity) => {
      activities.push(value);
      return registration();
    },
    registerCommand: (value: DoomHeadlessCommand) => {
      commands.push(value);
      return registration();
    },
    registerTool: (value: DoomHeadlessTool) => {
      tools.push(value);
      return registration();
    },
  } as unknown as DoomHeadlessHostService;
  const context = new Context();
  context.provide(DOOM_SERVER_HOST_SERVICE, {
    scope: 'session',
    context: { workspaceRoot: managed ? root : undefined },
    registerApi: registration,
  });
  context.provide(DOOM_HEADLESS_HOST_SERVICE, host);
  if (resolver) context.provide(DOOM_MCP_PROJECTION_RESOLVER_SERVICE, resolver);
  const close = await mcpHeadlessFacet.apply(context);
  cleanups.push(async () => {
    await close?.();
  });
  const start = async () => {
    const stop = await activities[0]!.start(execution);
    let stopped = false;
    const stopOnce = async () => {
      if (!stopped) {
        stopped = true;
        await stop();
      }
    };
    cleanups.push(stopOnce);
    return stopOnce;
  };
  const service = () => context.get(MCP_SESSION_TOOLS_SERVICE) as McpSessionToolsService;
  const childTool = () => context.get(DOOM_CHILD_SESSION_MCP_TOOL_SERVICE) as DoomChildSessionTool | undefined;
  const select = async (domains: readonly string[], majorMode = 'doom') => {
    const selection = { majorMode, activeLayers: [], domains };
    for (const listener of selectionListeners) await listener(selection);
  };
  return {
    context,
    execution,
    statuses,
    resources,
    command: commands[0]!,
    tool: tools[0]!,
    start,
    service,
    childTool,
    select,
  };
}

async function connected() {
  const current = await setup();
  const stop = await current.start();
  await vi.waitFor(() => expect(mock.options).toHaveLength(1));
  mock.options[0]!.onServerStateChange?.({ serverName: 'example', state: 'connected' });
  await vi.waitFor(() => expect(current.service().snapshot()).toHaveLength(1));
  return { ...current, stop };
}

describe('MCP server facet contracts', () => {
  it('keeps config out of the prompt and rejects tools before startup', async () => {
    const current = await setup();
    expect(current.resources).toEqual([]);
    expect(
      await current.tool.execute('call', { server: 'example', tool: 'ping' }, undefined, undefined, current.execution),
    ).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('not started') }] });
    expect(mock.ensureConnected).not.toHaveBeenCalled();
    await current.command.execute('auth example', current.execution);
    expect(current.execution.client.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: expect.stringContaining('not started'), level: 'warning' }),
    );
  });

  it('publishes every configured server before tool discovery', async () => {
    const current = await setup();
    await current.start();
    expect(parseMcpSessionAuthStatus(current.statuses[MCP_SESSION_AUTH_STATUS_KEY])).toEqual([
      { name: 'example', state: 'not-connected' },
      { name: 'pending', state: 'not-connected' },
    ]);
  });

  it('publishes the filtered parent MCP dispatcher for child sessions', async () => {
    const current = await connected();
    const childTool = current.childTool();
    expect(childTool?.name).toBe('mcp');
    await expect(childTool!.execute('child-call', { server: 'example', tool: 'ping' })).resolves.toMatchObject({
      content: [{ text: 'ok' }],
    });
    expect(mock.callTool).toHaveBeenLastCalledWith('ping', {}, { timeout: 500 });

    await current.command.execute('disconnect example', current.execution);
    await expect(
      childTool!.execute('child-after-disconnect', { server: 'example', tool: 'ping', arguments: {} }),
    ).rejects.toThrow('not available in this session');
  });

  it('publishes all server states, the shared status service, and upstream tools without the Pi adapter', async () => {
    const current = await connected();
    mock.options[0]!.onServerStateChange?.({ serverName: 'pending', state: 'failed', error: 'fixture failure' });
    await vi.waitFor(() =>
      expect(parseMcpSessionAuthStatus(current.statuses[MCP_SESSION_AUTH_STATUS_KEY])).toEqual([
        { name: 'example', state: 'connected' },
        { name: 'pending', state: 'failed' },
      ]),
    );
    const status = current.context.get(DOOM_MCP_STATUS_SERVICE) as DoomMcpStatusService;
    expect(status.getSnapshot().servers.find((server) => server.name === 'example')?.tools).toHaveLength(1);
    const lifecycle = new AbortController();
    const refresh = vi.fn();
    const tools = sessionMcp({
      services: { get: <T>(name: string) => current.context.get(name) as T | undefined },
      signal: lifecycle.signal,
      refresh,
    } as unknown as Parameters<typeof sessionMcp>[0]);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe(current.service().snapshot()[0]?.piName);
    await tools[0]!.execute('call', {}, undefined, undefined, current.execution);
    expect(mock.callTool).toHaveBeenCalledWith('ping', {}, { timeout: 500 });
    await current.command.execute('disconnect example', current.execution);
    expect(refresh).toHaveBeenCalled();
    expect(current.service().snapshot()).toEqual([]);
    lifecycle.abort();
  });

  it('runs genuine authorization without requesting a pasted code or blocking the command', async () => {
    const current = await connected();
    let finish!: () => void;
    mock.ensureConnected.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await current.command.execute('auth example', current.execution);
    await vi.waitFor(() => expect(mock.clearToken).toHaveBeenCalledWith('example'));
    expect(current.execution.client.request).not.toHaveBeenCalled();
    mock.options[0]!.onAuthorizationUrl?.(new URL('https://auth.example.test/authorize'), 'example');
    expect(parseMcpSessionAuthStatus(current.statuses[MCP_SESSION_AUTH_STATUS_KEY])?.[0]?.authorizationUrl).toBe(
      'https://auth.example.test/authorize',
    );
    expect(current.execution.client.notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ body: 'example is authorized.' }),
    );
    finish();
    await vi.waitFor(() =>
      expect(current.execution.client.notify).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'example is authorized.' }),
      ),
    );
  });

  it('disconnects without clearing credentials and prevents generic dispatch from reconnecting it', async () => {
    const current = await connected();
    await current.command.execute('disconnect example', current.execution);
    expect(mock.disconnect).toHaveBeenCalledWith('example');
    expect(mock.clearToken).not.toHaveBeenCalled();
    expect(parseMcpSessionAuthStatus(current.statuses[MCP_SESSION_AUTH_STATUS_KEY])?.[0]?.state).toBe('closed');
    mock.ensureConnected.mockClear();
    expect(
      await current.tool.execute('call', { server: 'example', tool: 'ping' }, undefined, undefined, current.execution),
    ).toMatchObject({ isError: true });
    expect(mock.ensureConnected).not.toHaveBeenCalled();
  });

  it('normalizes non-Error disconnect failures', async () => {
    const current = await connected();
    mock.disconnect.mockRejectedValueOnce('disconnect failed');
    await current.command.execute('disconnect example', current.execution);
    expect(current.execution.client.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: 'disconnect failed', level: 'warning' }),
    );
  });

  it('normalizes non-Error MCP invocation failures', async () => {
    const current = await connected();
    mock.ensureConnected.mockRejectedValueOnce('connection failed');
    await expect(
      current.tool.execute('call', { server: 'example', tool: 'ping' }, undefined, undefined, current.execution),
    ).resolves.toMatchObject({ isError: true, content: [{ text: 'connection failed' }] });
  });

  it('reloads changed source contents even when their configured paths are unchanged', async () => {
    const current = await connected();
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { replacement: { command: 'unused-fixture' } } }),
    );
    await current.command.execute('reload', current.execution);
    expect(parseMcpSessionAuthStatus(current.statuses[MCP_SESSION_AUTH_STATUS_KEY])).toEqual([
      { name: 'replacement', state: 'not-connected' },
    ]);
    expect(current.service().snapshot()).toEqual([]);
  });

  it('discovers repository MCP from exact session cwd while retaining selected projection policy', async () => {
    const configPath = path.join(root, '.mcp.json');
    const contents = fs.readFileSync(configPath);
    const projection: DoomMcpProjection = {
      version: 1,
      enabled: true,
      fingerprint: 'selected',
      repoRoot: root,
      stagingDirectory: path.join(root, 'projection-stage'),
      sources: [
        {
          sourceId: 'repository:selected',
          owner: 'repository',
          format: 'native',
          configPath,
          contentDigest: createHash('sha256').update(contents).digest('hex'),
        },
      ],
    };
    const sessionCwd = path.join(root, 'nested');
    fs.mkdirSync(sessionCwd);
    const sessionConfigPath = path.join(sessionCwd, '.mcp.json');
    fs.writeFileSync(sessionConfigPath, JSON.stringify({ mcpServers: { selected: { command: 'selected-server' } } }));
    const current = await setup(true, projection, true, sessionCwd);
    expect(current.execution.cwd).toBe(sessionCwd);
    expect(current.execution.repoRoot).toBe(root);
    await current.start();
    expect(parseMcpSessionAuthStatus(current.statuses[MCP_SESSION_AUTH_STATUS_KEY])).toEqual([
      { name: 'selected', state: 'not-connected' },
    ]);
    await vi.waitFor(() => expect(mock.options).toHaveLength(1));
    expect(mock.options[0]?.configSources).toEqual([
      expect.objectContaining({ path: sessionConfigPath, format: 'claude' }),
    ]);
    expect(mock.options[0]?.workspaceRoot).toBe(root);
    expect(mock.options[0]?.executionCwd).toBe(sessionCwd);
    expect(mock.options[0]?.environment).toMatchObject(current.execution.environment);
    await current.command.execute('reload', current.execution);
    expect(parseMcpSessionAuthStatus(current.statuses[MCP_SESSION_AUTH_STATUS_KEY])).toEqual([
      { name: 'selected', state: 'not-connected' },
    ]);
  });

  it('loads a domain-selected plugin MCP source without broadening to repository servers', async () => {
    const configPath = path.join(root, 'plugin.mcp.json');
    const content = JSON.stringify({ mcpServers: { pluginOnly: { command: 'plugin-server' } } });
    fs.writeFileSync(configPath, content);
    const sessionCwd = path.join(root, 'plugin-session');
    fs.mkdirSync(sessionCwd);
    const current = await setup(
      true,
      {
        version: 1,
        enabled: true,
        fingerprint: 'selected-plugin',
        repoRoot: root,
        stagingDirectory: path.join(root, 'projection-stage'),
        sources: [
          {
            sourceId: 'plugin:selected',
            owner: 'plugin',
            format: 'native',
            configPath,
            contentDigest: createHash('sha256').update(content).digest('hex'),
          },
        ],
      },
      true,
      sessionCwd,
    );
    await current.start();
    expect(parseMcpSessionAuthStatus(current.statuses[MCP_SESSION_AUTH_STATUS_KEY])).toEqual([
      { name: 'pluginOnly', state: 'not-connected' },
    ]);
    await vi.waitFor(() =>
      expect(mock.options[0]?.configSources).toEqual([expect.objectContaining({ path: configPath })]),
    );
  });
  it.each(['revived', 'switched'] as const)('resolves domain MCP for a %s session selection', async (scenario) => {
    const configPath = path.join(root, 'plugin.mcp.json');
    const content = JSON.stringify({ mcpServers: { pluginOnly: { command: 'plugin-server' } } });
    fs.writeFileSync(configPath, content);
    const initial: DoomMcpProjection = {
      version: 1,
      enabled: true,
      fingerprint: 'initial',
      repoRoot: root,
      stagingDirectory: path.join(root, 'projection-stage'),
      sources: [],
    };
    const resolve = vi.fn(async (domains: readonly string[]) => ({
      projection: {
        ...initial,
        fingerprint: JSON.stringify(domains),
        sources: domains.includes('staging')
          ? [
              {
                sourceId: 'plugin:selected',
                owner: 'plugin' as const,
                format: 'native' as const,
                configPath,
                contentDigest: createHash('sha256').update(content).digest('hex'),
              },
            ]
          : [],
      },
      cleanup: async () => {},
    }));
    const current = await setup(true, initial, true, root, { resolve });
    if (scenario === 'revived') Object.assign(current.execution.selection, { domains: ['initial', 'staging'] });
    await current.start();
    if (scenario === 'switched') {
      await current.select(['initial', 'staging']);
      await current.select(['initial', 'staging'], 'other');
    }
    expect(resolve).toHaveBeenLastCalledWith(['initial', 'staging']);
    expect(parseMcpSessionAuthStatus(current.statuses[MCP_SESSION_AUTH_STATUS_KEY])).toEqual([
      { name: 'pluginOnly', state: 'not-connected' },
    ]);
  });

  it('publishes domain plugin servers before discovery and withdraws them when deselected', async () => {
    const pluginConfig = path.join(root, 'staging.mcp.json');
    const contents = JSON.stringify({
      mcpServers: {
        'agiflow-mcp': { type: 'http', url: 'https://agiflow.agimon.win/api/v1/mcp/0.0.3' },
        'boomlink-mcp': { type: 'http', url: 'https://boomlink.agimon.win/api/v1/mcp/0.0.1' },
      },
    });
    fs.writeFileSync(pluginConfig, contents);
    const baseline = path.join(root, '.mcp.json');
    const source = (configPath: string, owner: 'plugin' | 'repository') => ({
      sourceId: `${owner}:${configPath}`,
      owner,
      format: 'native' as const,
      configPath,
      contentDigest: createHash('sha256').update(fs.readFileSync(configPath)).digest('hex'),
    });
    const initial: DoomMcpProjection = {
      version: 1,
      enabled: true,
      fingerprint: 'initial',
      repoRoot: root,
      stagingDirectory: path.join(root, 'projection-stage'),
      sources: [source(baseline, 'repository')],
    };
    const cleanup = vi.fn(async () => {});
    const resolve = vi.fn(async (domains: readonly string[]) => ({
      projection: {
        ...initial,
        fingerprint: JSON.stringify(domains),
        sources: [
          source(baseline, 'repository'),
          ...(domains.includes('staging') ? [source(pluginConfig, 'plugin')] : []),
        ],
      },
      cleanup,
    }));
    const current = await setup(true, initial, true, root, { resolve });
    await current.start();
    await current.select(['initial', 'staging']);
    expect(parseMcpSessionAuthStatus(current.statuses[MCP_SESSION_AUTH_STATUS_KEY])).toEqual([
      { name: 'example', state: 'not-connected' },
      { name: 'pending', state: 'not-connected' },
      { name: 'agiflow-mcp', state: 'not-connected' },
      { name: 'boomlink-mcp', state: 'not-connected' },
    ]);
    await current.command.execute('reload', current.execution);
    expect(resolve).toHaveBeenLastCalledWith(['initial', 'staging']);
    await current.select(['initial']);
    expect(
      parseMcpSessionAuthStatus(current.statuses[MCP_SESSION_AUTH_STATUS_KEY])?.map((server) => server.name),
    ).toEqual(['example', 'pending']);
    expect(cleanup).toHaveBeenCalled();
    await current.select(['initial', 'staging']);
    expect(
      parseMcpSessionAuthStatus(current.statuses[MCP_SESSION_AUTH_STATUS_KEY])?.map((server) => server.name),
    ).toContain('agiflow-mcp');
  });

  it('withdraws managed tools when selection domains change and refuses stale reload', async () => {
    const configPath = path.join(root, '.mcp.json');
    const contents = fs.readFileSync(configPath);
    const current = await setup(
      true,
      {
        version: 1,
        enabled: true,
        fingerprint: 'initial',
        repoRoot: root,
        stagingDirectory: path.join(root, 'projection-stage'),
        sources: [
          {
            sourceId: 'repository:mcp',
            owner: 'repository',
            format: 'native',
            configPath,
            contentDigest: createHash('sha256').update(contents).digest('hex'),
          },
        ],
      },
      true,
    );
    await current.start();
    await vi.waitFor(() => expect(mock.options).toHaveLength(1));
    mock.options[0]!.onServerStateChange?.({ serverName: 'example', state: 'connected' });
    await vi.waitFor(() => expect(current.service().snapshot()).toHaveLength(1));
    await current.select(['changed']);
    await vi.waitFor(() => expect(current.service().snapshot()).toEqual([]));
    expect(
      await current.tool.execute('call', { server: 'example', tool: 'ping' }, undefined, undefined, current.execution),
    ).toMatchObject({ isError: true, content: [{ text: expect.stringContaining('stale') }] });
    await expect(current.childTool()!.execute('call', { server: 'example', tool: 'ping' })).rejects.toThrow('stale');
    await current.command.execute('reload', current.execution);
    expect(current.service().snapshot()).toEqual([]);
    expect(mock.options).toHaveLength(1);
    expect(current.execution.client.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: expect.stringContaining('stale'), level: 'warning' }),
    );
  });

  it('fails closed when a managed projection is missing despite ambient repository and environment', async () => {
    const current = await setup(true, undefined, true);
    await current.start();
    expect(current.service().snapshot()).toEqual([]);
    expect(current.statuses[MCP_SESSION_AUTH_STATUS_KEY]).toBeUndefined();
    expect(mock.start).not.toHaveBeenCalled();
    await current.command.execute('reload', current.execution);
    expect(current.service().snapshot()).toEqual([]);
    expect(mock.start).not.toHaveBeenCalled();
  });

  it('honors an explicitly empty managed projection instead of the ambient repository', async () => {
    const current = await setup(
      true,
      {
        version: 1,
        enabled: true,
        fingerprint: 'empty',
        repoRoot: root,
        stagingDirectory: path.join(root, 'projection-stage'),
        sources: [],
      },
      true,
    );
    await current.start();
    expect(current.service().snapshot()).toEqual([]);
    expect(mock.start).not.toHaveBeenCalled();
  });

  it('keeps explicitly disabled sessions empty and never creates a runtime', async () => {
    const current = await setup(false);
    await current.start();
    expect(current.statuses[MCP_SESSION_AUTH_STATUS_KEY]).toBeUndefined();
    expect(current.service().snapshot()).toEqual([]);
    expect(mock.start).not.toHaveBeenCalled();
    await current.command.execute('auth example', current.execution);
    expect(mock.disconnect).not.toHaveBeenCalled();
  });

  it('reports startup errors and clears state and stale callbacks on stop', async () => {
    mock.start.mockRejectedValueOnce(new Error('startup failed'));
    const current = await setup();
    const stop = await current.start();
    await vi.waitFor(() =>
      expect(current.execution.client.notify).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining('startup failed') }),
      ),
    );
    await stop();
    mock.options[0]!.onAuthorizationUrl?.(new URL('https://auth.example.test/late'), 'example');
    expect(current.statuses).toEqual({});
    expect(current.service().snapshot()).toEqual([]);
  });

  it('withdraws status and tools even when runtime disposal fails', async () => {
    const current = await connected();
    mock.dispose.mockRejectedValueOnce(new Error('disconnect failed'));
    await expect(current.stop()).rejects.toThrow('disconnect failed');
    expect(current.statuses).toEqual({});
    expect(current.service().snapshot()).toEqual([]);
  });

  it('fails closed when reload cannot dispose the old runtime', async () => {
    const current = await connected();
    mock.dispose.mockRejectedValueOnce(new Error('disconnect failed'));
    await current.command.execute('reload', current.execution);
    expect(current.statuses[MCP_SESSION_AUTH_STATUS_KEY]).toBeUndefined();
    expect(current.service().snapshot()).toEqual([]);
    expect(mock.start).toHaveBeenCalledTimes(1);
    expect(current.execution.client.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: 'disconnect failed',
        level: 'warning',
      }),
    );
  });

  it('isolates session state and validates management commands before touching connections', async () => {
    const first = await connected();
    const second = await setup(false);
    await second.start();
    expect(first.service().snapshot()).toHaveLength(1);
    expect(second.service().snapshot()).toEqual([]);
    mock.disconnect.mockClear();
    for (const args of ['auth', 'auth missing', 'disconnect missing', 'unexpected'])
      await first.command.execute(args, first.execution);
    expect(mock.disconnect).not.toHaveBeenCalled();
    await first.command.execute('status', first.execution);
    expect(first.execution.client.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: expect.stringContaining('example: connected') }),
    );
  });
});
