import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  createDoomMcpProjectionService,
  DOOM_MCP_PROJECTION_SERVICE,
  type DoomMcpProjection,
  type DoomMcpProjectionService,
} from '@agimon-ai/doompi-extension-contracts/mcp-projection';
import {
  DOOM_CORDIS_HOST_REQUIRED_ENV,
  installDoomCordisHost,
  type DoomCordisHostController,
} from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { readDoomMcpStatus } from '@agimon-ai/doompi-extension-contracts/mcp-status';
import { readDoomMcpToolResolver } from '@agimon-ai/doompi-extension-contracts/mcp-tool-resolver';
import type { EventBusLike } from '@agimon-ai/doompi-extension-contracts/protocol';
import { DOOM_UI_HUB_SERVICE, type DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { Context, Fiber } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { McpServerStateChange } from '@agimon-ai/mcp-proxy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMcpExtension } from '../src/adapters/pi/extension.ts';
import { LEADER_GROUP, LEADER_KEY, PACKAGE_SOURCE } from '../src/adapters/pi/mcpConstants.ts';
import { COMMAND_NAME } from '../src/schemas/mcpCommands.ts';
import { SESSION_ENV_VAR } from '../src/schemas/sessionConfig.ts';

const SESSION_ID = 'session-1';
const DEFERRED_RUNTIME_TIMEOUT_MS = 5_000;
const createProxyContainer = vi.fn();
const openExternalUrl = vi.hoisted(() => vi.fn());

vi.mock('@agimon-ai/mcp-proxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agimon-ai/mcp-proxy')>()),
  createProxyContainer: (...args: unknown[]) => createProxyContainer(...args),
}));

vi.mock('open', () => ({ default: openExternalUrl }));

/** Working bus for the Cordis host's one intentional discovery boundary. */
class TestBus implements EventBusLike {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  emit(event: string, data: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(data);
  }

  on(event: string, handler: (data: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }
}

let repoRoot: string;
let notify: ReturnType<typeof vi.fn>;
let custom: ReturnType<typeof vi.fn>;
let setStatus: ReturnType<typeof vi.fn>;
let disconnectServer: ReturnType<typeof vi.fn>;
let ensureConnected: ReturnType<typeof vi.fn>;
let containerDispose: ReturnType<typeof vi.fn>;
let emitServerState: ((change: McpServerStateChange) => void) | undefined;
let sessionManager: { getSessionId(): string };

/** Headless by default: `hasUI` is absent, which is how a non-TUI session reads. */
function sessionContext(hasUI = false, cwd = repoRoot, includeUI = true): ExtensionContext {
  return {
    mode: hasUI ? 'tui' : 'headless',
    hasUI,
    cwd,
    sessionManager,
    ...(includeUI ? { ui: { notify, custom, setStatus } } : {}),
  } as unknown as ExtensionContext;
}

type CommandDefinition = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
type SessionListener = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;

interface RegisteredExtension {
  pi: ExtensionAPI;
  bus: TestBus;
  ready: Promise<void>;
  hostRoot(): Context | undefined;
  registeredTools: string[];
  activeTools(): string[];
  runCommand(args?: string, hasUI?: boolean): Promise<void>;
  startSession(cwd?: string, includeUI?: boolean, hasUI?: boolean): Promise<void>;
  shutdownSession(): Promise<void>;
}

const registeredExtensions: RegisteredExtension[] = [];

interface RegisterExtensionOptions {
  readonly bus?: TestBus;
  /** An object selects the composed-host path; omit it for standalone behavior. */
  readonly host?: {
    readonly service?: DoomMcpProjectionService;
    readonly uiHub?: DoomUiHubService;
  };
}

function registerExtension(options: RegisterExtensionOptions | TestBus = {}): RegisteredExtension {
  const normalized = options instanceof TestBus ? { bus: options } : options;
  const bus = normalized.bus ?? new TestBus();
  const commands = new Map<string, CommandDefinition>();
  // One list per event: the leader contribution and the session wiring both listen
  // for session_start, and Pi delivers to every listener.
  const listeners = new Map<string, SessionListener[]>();
  const fire = async (event: string, cwd = repoRoot, includeUI = true, hasUI = false): Promise<void> => {
    for (const listener of listeners.get(event) ?? []) {
      await listener({}, sessionContext(hasUI, cwd, includeUI));
    }
  };
  const registeredTools: string[] = [];
  let active: string[] = ['read'];

  const pi = {
    events: bus,
    registerCommand: vi.fn((name: string, definition: CommandDefinition) => commands.set(name, definition)),
    registerTool: vi.fn((definition: { name: string }) => registeredTools.push(definition.name)),
    getActiveTools: vi.fn(() => [...active]),
    setActiveTools: vi.fn((names: string[]) => {
      active = [...names];
    }),
    on: vi.fn((event: string, handler: SessionListener) =>
      listeners.set(event, [...(listeners.get(event) ?? []), handler]),
    ),
  } as unknown as ExtensionAPI;

  let hostController: DoomCordisHostController | undefined;
  let projectionFiber: Fiber | undefined;
  let uiFiber: Fiber | undefined;
  const ready = (async () => {
    if (normalized.host) {
      hostController = await installDoomCordisHost(pi, { mode: 'composed', source: 'doompi-mcp-test' });
      if (normalized.host.service) {
        projectionFiber = hostController.root.plugin((ctx: Context, service: DoomMcpProjectionService) => {
          ctx.provide(DOOM_MCP_PROJECTION_SERVICE, service);
        }, normalized.host.service);
        await projectionFiber.await();
      }
      if (normalized.host.uiHub) {
        uiFiber = hostController.root.plugin((ctx: Context, service: DoomUiHubService) => {
          ctx.provide(DOOM_UI_HUB_SERVICE, service);
        }, normalized.host.uiHub);
        await uiFiber.await();
      }
    }
    await registerMcpExtension(pi);
  })();
  let shutdown: Promise<void> | undefined;

  const extension = {
    pi,
    bus,
    ready,
    hostRoot: () => hostController?.root,
    registeredTools,
    activeTools: () => active,
    runCommand: async (args = '', hasUI = false) => {
      await ready;
      await commands.get(COMMAND_NAME)?.handler(args, sessionContext(hasUI));
    },
    startSession: async (cwd = repoRoot, includeUI = true, hasUI = false) => {
      await ready;
      await fire('session_start', cwd, includeUI, hasUI);
    },
    shutdownSession: () =>
      (shutdown ??= (async () => {
        await ready.catch(() => undefined);
        await fire('session_shutdown');
        await uiFiber?.dispose();
        await projectionFiber?.dispose();
        await hostController?.shutdown();
      })()),
  };
  registeredExtensions.push(extension);
  return extension;
}

function projectionService(projection: DoomMcpProjection, serviceSessionId = SESSION_ID): DoomMcpProjectionService {
  return createDoomMcpProjectionService({
    sessionId: serviceSessionId,
    generation: 'generation-1',
    projection,
  });
}

function nativeProjection(configPath: string, enabled = true): DoomMcpProjection {
  const contents = fs.readFileSync(configPath);
  return {
    version: 1,
    enabled,
    fingerprint: createHash('sha256')
      .update(contents)
      .update(enabled ? 'enabled' : 'disabled')
      .digest('hex'),
    repoRoot: path.dirname(configPath),
    stagingDirectory: path.join(path.dirname(configPath), '.staging'),
    sources: enabled
      ? [
          {
            sourceId: 'repository:mcp',
            owner: 'repository',
            format: 'native',
            configPath,
            contentDigest: createHash('sha256').update(contents).digest('hex'),
          },
        ]
      : [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv(DOOM_CORDIS_HOST_REQUIRED_ENV, '');
  registeredExtensions.length = 0;
  notify = vi.fn();
  custom = vi.fn().mockResolvedValue(undefined);
  setStatus = vi.fn();
  openExternalUrl.mockResolvedValue(undefined);
  disconnectServer = vi.fn().mockResolvedValue(undefined);
  ensureConnected = vi.fn().mockResolvedValue(undefined);
  containerDispose = vi.fn().mockResolvedValue(undefined);
  emitServerState = undefined;
  sessionManager = { getSessionId: () => SESSION_ID };
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-mcp-ext-'));
  fs.writeFileSync(
    path.join(repoRoot, '.mcp.json'),
    JSON.stringify({ mcpServers: { pencil: { type: 'stdio', command: 'pencil' } } }),
  );
  process.env[SESSION_ENV_VAR] = JSON.stringify({
    repoRoot,
    stagingDirectory: path.join(repoRoot, '.staging'),
  });
  createProxyContainer.mockImplementation(() =>
    Promise.resolve({
      clientManager: {
        onServerStateChange: (listener: (change: McpServerStateChange) => void) => {
          emitServerState = listener;
          return () => undefined;
        },
        getClient: () => undefined,
        disconnectServer,
        ensureConnected,
      },
      connectionsSettled: Promise.resolve(),
      dispose: containerDispose,
    }),
  );
});

afterEach(async () => {
  for (const extension of registeredExtensions) await extension.shutdownSession();
  registeredExtensions.length = 0;
  vi.unstubAllEnvs();
  delete process.env[SESSION_ENV_VAR];
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('doom mcp extension', () => {
  it('registers its command and lifecycle handlers', async () => {
    const { pi, ready } = registerExtension();
    await ready;

    expect(pi.registerCommand).toHaveBeenCalledWith(
      COMMAND_NAME,
      expect.objectContaining({ handler: expect.any(Function) }),
    );
    expect(pi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith('session_shutdown', expect.any(Function));
  });

  // The whole point of the cached catalog: a slow server must not delay install.
  it('installs without building a proxy container', async () => {
    const extension = registerExtension();
    await extension.ready;

    expect(createProxyContainer).not.toHaveBeenCalled();
  });

  it('starts connecting only once a session begins', async () => {
    const extension = registerExtension();

    await extension.startSession();
    await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledOnce(), {
      timeout: DEFERRED_RUNTIME_TIMEOUT_MS,
    });

    expect(createProxyContainer).toHaveBeenCalledWith(expect.objectContaining({ startupMode: 'background' }));
  });

  it('consumes the immutable Doom projection instead of the legacy environment', async () => {
    const projectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-mcp-projected-'));
    const projectedConfig = path.join(projectedRoot, '.mcp.json');
    fs.writeFileSync(
      projectedConfig,
      JSON.stringify({ mcpServers: { projected: { type: 'stdio', command: 'projected-server' } } }),
    );
    const extension = registerExtension({ host: { service: projectionService(nativeProjection(projectedConfig)) } });

    await extension.startSession();
    await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledOnce());

    expect(createProxyContainer).toHaveBeenCalledWith(
      expect.objectContaining({ configSources: [{ path: projectedConfig, format: 'claude' }] }),
    );
    fs.rmSync(projectedRoot, { recursive: true, force: true });
  });

  it('fails closed when a Doom root has no projection provider', async () => {
    const extension = registerExtension({ host: {} });

    await extension.startSession();

    expect(createProxyContainer).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('fails closed when the projection provider belongs to another session', async () => {
    const extension = registerExtension({
      host: {
        service: projectionService(nativeProjection(path.join(repoRoot, '.mcp.json')), 'another-session'),
      },
    });

    await extension.startSession();

    expect(createProxyContainer).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('belongs to session "another-session"'), 'warning');
  });

  it('reads the projection only inside the injected Cordis consumer', async () => {
    const projection = nativeProjection(path.join(repoRoot, '.mcp.json'));
    let sessionIdReads = 0;
    const extension = registerExtension({
      host: {
        service: {
          get sessionId() {
            sessionIdReads += 1;
            return SESSION_ID;
          },
          generation: 'generation-1',
          getSnapshot: () => projection,
        },
      },
    });

    await extension.startSession();
    await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledOnce());

    expect(sessionIdReads).toBe(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not start a runtime for an explicit disabled projection', async () => {
    const extension = registerExtension({
      host: { service: projectionService(nativeProjection(path.join(repoRoot, '.mcp.json'), false)) },
    });

    await extension.startSession();

    expect(createProxyContainer).not.toHaveBeenCalled();
  });

  it('does not churn the runtime for repeated session_start with the same projection generation', async () => {
    const extension = registerExtension({
      host: { service: projectionService(nativeProjection(path.join(repoRoot, '.mcp.json'))) },
    });

    await extension.startSession();
    await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledOnce());
    await extension.startSession();

    expect(createProxyContainer).toHaveBeenCalledTimes(1);
  });

  it('lets the shared Cordis root retire the MCP session before its later shutdown hook', async () => {
    const extension = registerExtension({
      host: { service: projectionService(nativeProjection(path.join(repoRoot, '.mcp.json'))) },
    });
    await extension.ready;
    const root = extension.hostRoot();
    if (!root) throw new Error('Expected a composed Cordis test host.');
    await extension.startSession();
    await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledOnce());
    expect(readDoomMcpStatus(root)).toBeDefined();
    expect(readDoomMcpToolResolver(root)).toBeDefined();

    await root.fiber.dispose();

    expect(containerDispose).toHaveBeenCalledTimes(1);
    expect(readDoomMcpStatus(root)).toBeUndefined();
    expect(readDoomMcpToolResolver(root)).toBeUndefined();
    await extension.shutdownSession();
    expect(containerDispose).toHaveBeenCalledTimes(1);
  });

  it('retains the synchronized environment projection in the standard factory', async () => {
    const contextRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-mcp-context-'));
    fs.writeFileSync(
      path.join(contextRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { contextServer: { type: 'stdio', command: 'context-server' } } }),
    );
    const extension = registerExtension();

    await extension.startSession(contextRoot);
    await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledOnce(), {
      timeout: DEFERRED_RUNTIME_TIMEOUT_MS,
    });

    expect(createProxyContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        configSources: [{ path: path.join(repoRoot, '.mcp.json'), format: 'claude' }],
      }),
    );
    fs.rmSync(contextRoot, { recursive: true, force: true });
  });

  it('re-reads the current Doom projection at every session start', async () => {
    const nextRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-mcp-next-domain-'));
    fs.writeFileSync(
      path.join(nextRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { figma: { type: 'stdio', command: 'figma' } } }),
    );
    const extension = registerExtension(new TestBus());
    process.env[SESSION_ENV_VAR] = JSON.stringify({
      repoRoot: nextRoot,
      stagingDirectory: path.join(nextRoot, '.staging'),
      generatedConfigPath: path.join(nextRoot, 'mcp.json'),
    });

    await extension.startSession();
    await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledOnce(), {
      timeout: DEFERRED_RUNTIME_TIMEOUT_MS,
    });

    expect(createProxyContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        configSources: [{ path: path.join(nextRoot, '.mcp.json'), format: 'claude' }],
      }),
    );
    fs.rmSync(nextRoot, { recursive: true, force: true });
  });

  it('keeps a headless session usable when optional UI integrations are absent', async () => {
    const extension = registerExtension();

    await expect(extension.startSession(repoRoot, false)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledOnce(), {
      timeout: DEFERRED_RUNTIME_TIMEOUT_MS,
    });
  });

  it('cancels deferred startup when the session shuts down immediately', async () => {
    const extension = registerExtension();

    const starting = extension.startSession();
    await extension.shutdownSession();
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(createProxyContainer).not.toHaveBeenCalled();
  });

  // Reported before anything has connected, so the panel is never blank while the
  // session is still dialling out.
  it('publishes configured servers through the session status service', async () => {
    const extension = registerExtension({
      host: { service: projectionService(nativeProjection(path.join(repoRoot, '.mcp.json'))) },
    });
    await extension.startSession();
    await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledOnce());
    const root = extension.hostRoot();
    if (!root) throw new Error('Expected a composed Cordis test host.');

    expect(readDoomMcpStatus(root)?.getSnapshot()).toEqual({
      servers: [{ name: 'pencil', state: 'not-connected', tools: [], resourceCount: 0 }],
    });
  });

  // The cockpit recognises `<server>_<tool>` calls by these names, and a
  // browser session never sees the catalog any other way.
  it('publishes the server names as the doom-mcp footer status and clears it on shutdown', async () => {
    const extension = registerExtension();
    await extension.startSession();
    await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledOnce());

    expect(setStatus).toHaveBeenCalledWith('doom-mcp', 'pencil');

    await extension.shutdownSession();
    expect(setStatus).toHaveBeenCalledWith('doom-mcp', undefined);
  });

  it('publishes only compact needs-auth rows and clears that browser status on shutdown', async () => {
    const extension = registerExtension();
    await extension.startSession();
    await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledOnce());

    emitServerState?.({
      serverName: 'pencil',
      state: 'needs-auth',
      error: 'secret=https://auth.example.test/?token=private',
    });

    const authPayload = JSON.stringify([{ name: 'pencil', state: 'needs-auth' }]);
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalledWith('doom-mcp-session-auth', authPayload));
    expect(setStatus.mock.calls.flatMap((call) => call.slice(1)).join('\n')).not.toContain('private');

    emitServerState?.({ serverName: 'pencil', state: 'connected' });
    await vi.waitFor(() => expect(setStatus).toHaveBeenCalledWith('doom-mcp-session-auth', undefined));

    await extension.shutdownSession();
    expect(setStatus).toHaveBeenLastCalledWith('doom-mcp-session-auth', undefined);
  });

  it('removes the status service after shutdown', async () => {
    const extension = registerExtension({
      host: { service: projectionService(nativeProjection(path.join(repoRoot, '.mcp.json'))) },
    });
    await extension.startSession();
    const root = extension.hostRoot();
    if (!root) throw new Error('Expected a composed Cordis test host.');
    expect(readDoomMcpStatus(root)).toBeDefined();
    expect(readDoomMcpToolResolver(root)).toBeDefined();

    await extension.shutdownSession();

    expect(readDoomMcpStatus(root)).toBeUndefined();
    expect(readDoomMcpToolResolver(root)).toBeUndefined();
  });

  describe('/mcp command', () => {
    it('lists each server with its state and tool count', async () => {
      const extension = registerExtension();
      await extension.startSession();
      await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledOnce());

      await extension.runCommand();

      expect(notify).toHaveBeenCalledWith('pencil: not-connected · 0 tools', 'info');
    });

    it('opens the browser where there is a terminal to draw it on', async () => {
      const extension = registerExtension();

      await extension.runCommand('', true);

      expect(custom).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ overlay: true }));
      expect(notify).not.toHaveBeenCalled();
    });

    // An overlay needs a terminal, so a headless or scripted session still has to
    // be able to ask what the session is connected to.
    it('falls back to the text status where there is not', async () => {
      const extension = registerExtension();
      await extension.startSession();
      await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledOnce());

      await extension.runCommand('', false);

      expect(custom).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith('pencil: not-connected · 0 tools', 'info');
    });

    it('keeps the status subcommand as text even in a terminal', async () => {
      const extension = registerExtension();
      await extension.startSession();
      await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledOnce());

      await extension.runCommand('status', true);

      expect(custom).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith('pencil: not-connected · 0 tools', 'info');
    });

    it('reports that nothing is configured when the repository declares no servers', async () => {
      fs.writeFileSync(path.join(repoRoot, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
      const extension = registerExtension();
      await extension.startSession();

      await extension.runCommand();

      expect(notify).toHaveBeenCalledWith('No MCP servers are configured for this session.', 'info');
    });

    it('rejects a subcommand it does not have', async () => {
      const extension = registerExtension();

      await extension.runCommand('teleport');

      expect(notify).toHaveBeenCalledWith(expect.stringContaining('Unknown /mcp subcommand'), 'warning');
    });

    it('asks which server to authorize when none was named', async () => {
      const extension = registerExtension();

      await extension.runCommand('auth');

      expect(notify).toHaveBeenCalledWith(expect.stringContaining('Name the server'), 'warning');
    });

    it('reports that the runtime is not up rather than failing silently', async () => {
      const extension = registerExtension();

      await extension.runCommand('auth boomlink');

      expect(notify).toHaveBeenCalledWith(expect.stringContaining('has not started yet'), 'warning');
    });

    it('opens the authorization page in the desktop browser after an explicit auth action', async () => {
      const authorizationUrl = new URL('https://auth.example.test/authorize?state=long-state');
      const extension = registerExtension();
      await extension.startSession(repoRoot, true, true);
      await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledOnce());
      const onAuthorizationUrl = createProxyContainer.mock.calls[0]?.[0]?.auth?.onAuthorizationUrl;
      ensureConnected.mockImplementation(async (serverName: string) => {
        await onAuthorizationUrl(authorizationUrl, serverName);
      });

      await extension.runCommand('auth pencil', true);

      await vi.waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith(authorizationUrl.toString()));
      expect(setStatus.mock.calls.some(([key]) => key === 'doom-mcp-session-auth')).toBe(false);
    });

    it('does not open an external browser for an explicit auth action in a headless session', async () => {
      const authorizationUrl = new URL('https://auth.example.test/authorize?state=headless-state');
      const extension = registerExtension();
      await extension.startSession(repoRoot, true, false);
      await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledOnce());
      const onAuthorizationUrl = createProxyContainer.mock.calls[0]?.[0]?.auth?.onAuthorizationUrl;
      ensureConnected.mockImplementation(async (serverName: string) => {
        await onAuthorizationUrl(authorizationUrl, serverName);
      });

      await extension.runCommand('auth pencil', false);

      expect(openExternalUrl).not.toHaveBeenCalled();
      expect(notify).toHaveBeenCalledWith(expect.stringContaining(authorizationUrl.toString()), 'info');
    });

    it('reconnects on reload', async () => {
      const extension = registerExtension();
      await extension.startSession();
      await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledOnce());

      await extension.runCommand('reload');
      await vi.waitFor(() => expect(createProxyContainer).toHaveBeenCalledTimes(2));

      expect(notify).toHaveBeenCalledWith('Reconnecting MCP servers.', 'info');
    });
  });

  describe('leader contribution', () => {
    it('registers a leader binding while the optional UI provider is live', async () => {
      const dispose = vi.fn();
      const registerLeader = vi.fn(() => ({ update: vi.fn(), dispose }));
      const hub = {
        registerLeader,
        registerLeaderActions: vi.fn(),
        registerFooter: vi.fn(),
        registerConfig: vi.fn(),
      } as unknown as DoomUiHubService;
      const extension = registerExtension({ host: { uiHub: hub } });
      await extension.ready;

      // Nested under the existing `extension` group rather than claiming a
      // top-level key, which would collide with another extension's.
      expect(registerLeader).toHaveBeenCalledWith(
        expect.objectContaining({
          source: PACKAGE_SOURCE,
          bindings: [
            expect.objectContaining({
              path: [expect.objectContaining({ key: LEADER_GROUP.key }), expect.objectContaining({ key: LEADER_KEY })],
            }),
          ],
        }),
      );
      await extension.shutdownSession();
      expect(dispose).toHaveBeenCalledOnce();
    });
  });
});
