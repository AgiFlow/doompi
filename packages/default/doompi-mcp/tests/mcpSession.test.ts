import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { McpServerStateChange } from '@agimon-ai/mcp-proxy';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpSession } from '../src/adapters/pi/mcpSession.ts';
import { SESSION_ENV_VAR } from '../src/schemas/sessionConfig.ts';
import type { McpSessionConfig } from '../src/types/mcpConfig.ts';

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
let runtimeDisposals: Array<ReturnType<typeof vi.fn>>;

function fakePi() {
  const registered: string[] = [];
  const definitions = new Map<
    string,
    { name: string; execute?: (toolCallId: string, params: unknown) => Promise<unknown> }
  >();
  let active: string[] = ['read'];
  const pi = {
    registerTool: vi.fn(
      (definition: { name: string; execute?: (toolCallId: string, params: unknown) => Promise<unknown> }) => {
        registered.push(definition.name);
        definitions.set(definition.name, definition);
      },
    ),
    getActiveTools: vi.fn(() => [...active]),
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

function session(pi: ExtensionAPI): McpSession {
  return new McpSession({
    pi,
    environment: {
      [SESSION_ENV_VAR]: JSON.stringify({ repoRoot, stagingDirectory: path.join(repoRoot, '.staging') }),
    },
    tokenStore: { read: vi.fn(), write: vi.fn(), clear: vi.fn() },
  });
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
  ensureConnected = vi.fn().mockResolvedValue({ callTool: vi.fn(), listTools, listResources });
  runtimeDisposals = [];

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
      },
      connectionsSettled: Promise.resolve(),
      dispose,
    });
  });
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('McpSession', () => {
  describe('install', () => {
    it('reports the configured servers before anything has connected', () => {
      const { pi } = fakePi();

      expect(session(pi).install()).toEqual({
        servers: [{ name: 'pencil', state: 'not-connected', tools: [], resourceCount: 0 }],
      });
    });

    it('does not build a container', () => {
      const { pi } = fakePi();

      session(pi).install();

      expect(createProxyContainer).not.toHaveBeenCalled();
    });

    it('exposes proxy upstreams as their actual MCP servers', () => {
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

      expect(
        session(pi)
          .install()
          .servers.map((server) => server.name),
      ).toEqual(['pencil', 'review-server', 'scaffold-mcp']);
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
    const active = session(pi);
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

  describe('session-only disconnect', () => {
    it('closes the connection, deactivates tools, keeps credentials and allows reauthorization', async () => {
      const { pi, activeTools, definitions } = fakePi();
      const active = session(pi);
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
        'not available',
      );
      expect(ensureConnected).not.toHaveBeenCalled();
      await active.reauthorize('pencil');
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(activeTools()).toContain('pencil_get_screenshot'));
    });

    it('ignores late tool discovery and connection events after disconnect', async () => {
      const { pi, activeTools } = fakePi();
      const active = session(pi);
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
      const active = session(pi);
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
    it('registers and activates its tools', async () => {
      const { pi, registered, activeTools } = fakePi();
      const active = session(pi);
      active.install();
      active.activate();
      await active.start();

      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(registered).toEqual(['pencil_get_screenshot']));

      expect(activeTools()).toEqual(['read', 'pencil_get_screenshot']);
      expect(active.getSnapshot().servers[0]).toMatchObject({ state: 'connected', tools: ['pencil_get_screenshot'] });
    });

    it('records a failure without asking the server for tools', async () => {
      const { pi, activeTools } = fakePi();
      const active = session(pi);
      active.install();
      active.activate();
      await active.start();

      emitState({ serverName: 'pencil', state: 'failed', error: 'spawn ENOENT' });
      await vi.waitFor(() => expect(active.getSnapshot().servers[0].state).toBe('failed'));

      expect(listTools).not.toHaveBeenCalled();
      expect(activeTools()).toEqual(['read']);
    });

    it('keeps the session alive when a connected server refuses to list its tools', async () => {
      listTools.mockRejectedValue(new Error('protocol error'));
      const { pi } = fakePi();
      const active = session(pi);
      active.install();
      active.activate();
      await active.start();

      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(active.getSnapshot().servers[0].state).toBe('connected'));

      expect(active.getSnapshot().servers[0].tools).toEqual([]);
    });

    // A `/domains` switch replaces the runtime; a change from the old one must not
    // write tools into the new session.
    it('ignores a change from a container that is no longer live', async () => {
      const { pi, registered } = fakePi();
      const active = session(pi);
      active.install();
      active.activate();
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
      const active = session(pi);
      active.install(configuration({ allowlist: { servers: ['pencil', 'boomlink'] } }));
      active.activate();
      await active.start();

      await active.reconfigure(configuration({ allowlist: { servers: ['boomlink', 'pencil'] } }));

      expect(createProxyContainer).toHaveBeenCalledOnce();
      expect(registered).toEqual([]);
    });

    it('rebuilds sources and allowlists while retiring the old runtime', async () => {
      const pluginConfig = path.join(repoRoot, 'design.mcp.json');
      fs.writeFileSync(pluginConfig, JSON.stringify({ mcpServers: { figma: { command: 'figma' } } }));
      const { pi, activeTools } = fakePi();
      const active = session(pi);
      active.install(configuration());
      active.activate();
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
      const active = session(pi);
      active.install(configuration());
      active.activate();
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
      const active = session(pi);
      active.install(configuration());
      active.activate();
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
        'not available in the current session configuration',
      );
    });

    it('rejects authorization callbacks from a retired generation', async () => {
      const { pi } = fakePi();
      const active = session(pi);
      active.install(configuration());
      active.activate();
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
    it('drops the connection first so a stale token cannot answer from cache', async () => {
      const { pi } = fakePi();
      const active = session(pi);
      active.install();
      active.activate();
      await active.start();

      await active.reauthorize('boomlink');

      expect(disconnectServer).toHaveBeenCalledWith('boomlink');
      expect(ensureConnected).toHaveBeenCalledWith('boomlink');
    });

    it('clears the previous URL before retry even when disconnect rejects without a state event', async () => {
      const active = session(fakePi().pi);
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
          pi: fakePi().pi,
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

      await expect(session(pi).reauthorize('boomlink')).rejects.toThrow('has not started yet');
    });
  });

  describe('enabling and disabling', () => {
    async function connectedSession() {
      const fake = fakePi();
      const active = session(fake.pi);
      active.install();
      active.activate();
      await active.start();
      emitState({ serverName: 'pencil', state: 'connected' });
      await vi.waitFor(() => expect(fake.activeTools()).toEqual(['read', 'pencil_get_screenshot']));
      return { ...fake, active };
    }

    it('withholds a disabled server tools while leaving the rest of Pi alone', async () => {
      const { active, activeTools } = await connectedSession();

      active.setEnabled('pencil', false);

      expect(activeTools()).toEqual(['read']);
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

  describe('listResources', () => {
    async function startedSession() {
      const { pi } = fakePi();
      const active = session(pi);
      active.install();
      active.activate();
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

      await expect(session(pi).listResources('pencil')).rejects.toThrow('has not started yet');
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
      const active = session(pi);
      const listener = vi.fn();
      active.install();
      active.activate();
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
      const active = session(pi);
      active.install();
      active.activate();
      await active.start();
      active.onChange(() => {
        throw new Error('render failed');
      });

      emitState({ serverName: 'pencil', state: 'connected' });

      await vi.waitFor(() => expect(activeTools()).toEqual(['read', 'pencil_get_screenshot']));
    });

    it('reports a listener failure rather than dropping it', async () => {
      const { pi } = fakePi();
      const active = session(pi);
      active.install();
      active.activate();
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
      const active = session(pi);
      active.install();
      active.activate();
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
      const active = session(pi);
      active.install();
      active.activate();
      await active.start();

      await active.dispose();

      await expect(active.reauthorize('pencil')).rejects.toThrow('has not started yet');
    });
  });

  it('builds no container when the repository declares no servers', async () => {
    writeRepoConfig({});
    const { pi } = fakePi();
    const active = session(pi);
    active.install();

    await active.start();

    expect(createProxyContainer).not.toHaveBeenCalled();
  });
});
