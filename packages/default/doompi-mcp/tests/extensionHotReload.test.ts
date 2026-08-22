import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  installDoomCordisHost,
  type DoomCordisHostController,
} from '@agimon-ai/doompi-extension-contracts/cordis-host';
import {
  createDoomMcpProjectionService,
  DOOM_MCP_PROJECTION_SERVICE,
  type DoomMcpProjection,
  type DoomMcpProjectionService,
} from '@agimon-ai/doompi-extension-contracts/mcp-projection';
import type { EventBusLike } from '@agimon-ai/doompi-extension-contracts/protocol';
import type { Context, Fiber } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMcpExtension } from '../src/adapters/pi/extension.ts';

const DEFERRED_RUNTIME_TIMEOUT_MS = 5_000;

const mocks = vi.hoisted(() => ({
  createProxyContainer: vi.fn(),
  projectionReadContexts: [] as unknown[],
}));

vi.mock('@agimon-ai/mcp-proxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agimon-ai/mcp-proxy')>()),
  createProxyContainer: (...argumentsValue: unknown[]) => mocks.createProxyContainer(...argumentsValue),
}));

vi.mock('@agimon-ai/doompi-extension-contracts/mcp-projection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agimon-ai/doompi-extension-contracts/mcp-projection')>();
  return {
    ...actual,
    readDoomMcpProjectionService: (context: Context) => {
      mocks.projectionReadContexts.push(context);
      return actual.readDoomMcpProjectionService(context);
    },
  };
});

vi.mock('../src/adapters/pi/leader.ts', () => ({
  registerLeaderContribution: () => () => undefined,
}));

class TestBus implements EventBusLike {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  on(event: string, listener: (payload: unknown) => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener);
  }
}

type SessionListener = (event: unknown, context: ExtensionContext) => void | Promise<void>;

interface ExtensionHarness {
  readonly controller: DoomCordisHostController;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

async function extensionHarness(context: ExtensionContext): Promise<ExtensionHarness> {
  const listeners = new Map<string, SessionListener[]>();
  let activeTools = ['read'];
  const pi = {
    events: new TestBus(),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((tools: string[]) => {
      activeTools = [...tools];
    }),
    on: vi.fn((event: string, listener: SessionListener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
  } as unknown as ExtensionAPI;

  const controller = await installDoomCordisHost(pi, { mode: 'composed', source: 'doompi-mcp-hot-reload-test' });
  await registerMcpExtension(pi);
  const fire = async (event: string): Promise<void> => {
    for (const listener of listeners.get(event) ?? []) await listener({}, context);
  };
  let shutdown: Promise<void> | undefined;
  return {
    controller,
    start: () => fire('session_start'),
    shutdown: () =>
      (shutdown ??= (async () => {
        await fire('session_shutdown');
        await controller.shutdown();
      })()),
  };
}

function nativeProjection(configPath: string, serverName: string): DoomMcpProjection {
  const contents = fs.readFileSync(configPath);
  return {
    version: 1,
    enabled: true,
    fingerprint: createHash('sha256').update(contents).update(serverName).digest('hex'),
    repoRoot: path.dirname(configPath),
    stagingDirectory: path.join(path.dirname(configPath), '.staging'),
    sources: [
      {
        sourceId: `repository:${serverName}`,
        owner: 'repository',
        format: 'native',
        configPath,
        contentDigest: createHash('sha256').update(contents).digest('hex'),
      },
    ],
  };
}

function projectionPlugin(context: Context, service: DoomMcpProjectionService): void {
  context.provide(DOOM_MCP_PROJECTION_SERVICE, service);
}

function runtime(dispose: () => Promise<void>) {
  return {
    clientManager: {
      onServerStateChange: () => () => undefined,
    },
    connectionsSettled: Promise.resolve(),
    dispose,
  };
}

describe('MCP extension Cordis hot reload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projectionReadContexts.length = 0;
  });

  it('retires projection A before reactive injection consumes projection B', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-mcp-hot-reload-'));
    const configA = path.join(directory, 'domain-a.mcp.json');
    const configB = path.join(directory, 'domain-b.mcp.json');
    fs.writeFileSync(configA, JSON.stringify({ mcpServers: { alpha: { command: 'alpha-server' } } }));
    fs.writeFileSync(configB, JSON.stringify({ mcpServers: { beta: { command: 'beta-server' } } }));

    const context = {
      cwd: directory,
      mode: 'headless',
      hasUI: false,
      sessionManager: { getSessionId: () => 'hot-reload-session' },
      ui: { notify: vi.fn() },
    } as unknown as ExtensionContext;
    const serviceA = createDoomMcpProjectionService({
      sessionId: 'hot-reload-session',
      generation: 'domain-a',
      projection: nativeProjection(configA, 'alpha'),
    });
    const serviceB = createDoomMcpProjectionService({
      sessionId: 'hot-reload-session',
      generation: 'domain-b',
      projection: nativeProjection(configB, 'beta'),
    });

    let releaseRuntimeA: (() => void) | undefined;
    const disposeRuntimeA = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseRuntimeA = resolve;
        }),
    );
    const disposeRuntimeB = vi.fn().mockResolvedValue(undefined);
    mocks.createProxyContainer
      .mockResolvedValueOnce(runtime(disposeRuntimeA))
      .mockResolvedValueOnce(runtime(disposeRuntimeB));

    let harness: ExtensionHarness | undefined;
    let providerA: Fiber | undefined;
    let providerB: Fiber | undefined;
    try {
      harness = await extensionHarness(context);
      providerA = harness.controller.root.plugin(projectionPlugin, serviceA);
      await providerA.await();
      await harness.start();
      await vi.waitFor(() => expect(mocks.createProxyContainer).toHaveBeenCalledTimes(1), {
        timeout: DEFERRED_RUNTIME_TIMEOUT_MS,
      });
      expect(mocks.createProxyContainer.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          configSources: [{ path: configA, format: 'claude' }],
          startupMode: 'background',
        }),
      );

      let providerARetired = false;
      const retireProviderA = providerA.dispose().then(() => {
        providerARetired = true;
      });
      await vi.waitFor(() => expect(disposeRuntimeA).toHaveBeenCalledOnce(), {
        timeout: DEFERRED_RUNTIME_TIMEOUT_MS,
      });
      expect(providerARetired).toBe(false);
      releaseRuntimeA?.();
      await retireProviderA;

      providerB = harness.controller.root.plugin(projectionPlugin, serviceB);
      await providerB.await();
      await vi.waitFor(() => expect(mocks.createProxyContainer).toHaveBeenCalledTimes(2), {
        timeout: DEFERRED_RUNTIME_TIMEOUT_MS,
      });
      expect(mocks.createProxyContainer.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({
          configSources: [{ path: configB, format: 'claude' }],
          startupMode: 'background',
        }),
      );

      const [injectedReadA, injectedReadB] = mocks.projectionReadContexts as Context[];
      expect(injectedReadA).not.toBe(harness.controller.root);
      expect(injectedReadA?.root).toBe(harness.controller.root);
      expect(injectedReadB?.root).toBe(harness.controller.root);

      await harness.shutdown();
      expect(disposeRuntimeA).toHaveBeenCalledTimes(1);
      expect(disposeRuntimeB).toHaveBeenCalledTimes(1);
      expect(injectedReadA?.fiber.uid).toBeNull();
      expect(injectedReadB?.fiber.uid).toBeNull();
    } finally {
      releaseRuntimeA?.();
      await providerA?.dispose();
      await providerB?.dispose();
      await harness?.shutdown();
      fs.rmSync(directory, { recursive: true, force: true });
    }

    expect(disposeRuntimeA).toHaveBeenCalledTimes(1);
    expect(disposeRuntimeB).toHaveBeenCalledTimes(1);
  });
});
