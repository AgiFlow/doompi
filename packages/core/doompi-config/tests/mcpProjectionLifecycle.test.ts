import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readDoomMcpProjectionService,
  type DoomMcpProjection,
} from '@agimon-ai/doompi-extension-contracts/mcp-projection';
import { readDoomReadinessCoordinator } from '@agimon-ai/doompi-extension-contracts/readiness';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';

const mocks = vi.hoisted(() => ({
  harness: {
    root: '/repo',
    temporaryDirectory: '/run/current',
    majorMode: 'copilot',
    domains: ['development'],
    mcp: true,
    mcpProjection: {
      version: 1,
      enabled: true,
      fingerprint: 'projection-1',
      repoRoot: '/repo',
      stagingDirectory: '/run/pinned',
      sources: [],
    } as DoomMcpProjection | undefined,
  },
  helpDispose: vi.fn(),
  createConfigContext: vi.fn(),
  notify: vi.fn(),
  recordEvent: vi.fn(),
  shutdownTelemetry: vi.fn(),
}));

vi.mock('../src/adapters/pi/helpContribution.ts', () => ({
  registerDoomConfigHelp: () => ({ dispose: mocks.helpDispose }),
}));
vi.mock('../src/adapters/pi/piContext.ts', () => ({
  acknowledgeDoomConfigTransition: vi.fn(),
  createDoomConfigContextAsync: mocks.createConfigContext,
  provideDoomConfigContext: vi.fn(() => vi.fn()),
}));
vi.mock('@agimon-ai/doompi-telemetry', () => ({
  createDoomTelemetry: () => ({
    recordEvent: mocks.recordEvent,
    shutdown: mocks.shutdownTelemetry,
  }),
}));

import { registerConfigExtension } from '../src/adapters/pi/configExtension.ts';

type Handler = (...argumentsValue: unknown[]) => unknown;

const CONFIG_PACKAGE_ID = '@agimon-ai/doompi-config';

class TestBus {
  private readonly handlers = new Map<string, Set<(value: unknown) => void>>();

  emit(event: string, value: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value);
  }

  on(event: string, handler: (value: unknown) => void): () => void {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }
}

function host(): {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  dispatch(event: string, context: ExtensionContext, reason?: string): Promise<void>;
} {
  const handlers = new Map<string, Handler[]>();
  const bus = new TestBus();
  const pi = {
    events: {
      emit: bus.emit.bind(bus),
      on: bus.on.bind(bus),
    },
    on(event: string, handler: Handler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
  } as unknown as ExtensionAPI;
  return {
    handlers,
    pi,
    async dispatch(event, extensionContext, reason = 'startup') {
      for (const handler of handlers.get(event) ?? []) {
        await handler({ type: event, reason }, extensionContext);
      }
    },
  };
}

function context(): ExtensionContext {
  return {
    cwd: '/repo/worktree',
    sessionManager: {
      getSessionId: () => 'session-1',
      getBranch: () => [],
    },
    hasUI: true,
    ui: { notify: mocks.notify },
  } as unknown as ExtensionContext;
}

function configValue() {
  return {
    settings: { projectTrust: 'ask' as const },
    harness: structuredClone(mocks.harness),
    requiresRelaunch: false,
  };
}

describe('Config MCP projection publication', () => {
  beforeEach(() => {
    mocks.harness.root = '/repo';
    mocks.harness.temporaryDirectory = '/run/current';
    mocks.harness.mcp = true;
    mocks.harness.mcpProjection = {
      version: 1,
      enabled: true,
      fingerprint: 'projection-1',
      repoRoot: '/repo',
      stagingDirectory: '/run/pinned',
      sources: [],
    };
    mocks.createConfigContext.mockImplementation(async () => configValue());
    vi.clearAllMocks();
  });

  afterEach(() => vi.clearAllMocks());

  it('publishes readiness before deferred config I/O and barriers downstream session startup', async () => {
    let finishConfig: (() => void) | undefined;
    mocks.createConfigContext.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishConfig = () => resolve(configValue());
        }),
    );
    const { pi, handlers, dispatch } = host();
    const extensionContext = context();
    await registerConfigExtension(pi);
    const connection = await connectDoomCordisHost(pi, 'config-mcp-projection-test');
    const root = connection.root;
    const downstream = vi.fn(() => {
      expect(readDoomMcpProjectionService(root)).toBeDefined();
    });
    pi.on('session_start', downstream);
    const startHandlers = handlers.get('session_start') ?? [];
    expect(startHandlers).toHaveLength(3);

    await startHandlers[0]?.({ type: 'session_start', reason: 'startup' }, extensionContext);

    const readiness = readDoomReadinessCoordinator(root);
    expect(readiness?.read(CONFIG_PACKAGE_ID)).toMatchObject({ state: 'pending' });
    expect(readDoomMcpProjectionService(root)).toBeUndefined();

    let barrierComplete = false;
    const barrier = (async () => {
      for (const handler of startHandlers.slice(1)) {
        await handler({ type: 'session_start', reason: 'startup' }, extensionContext);
      }
      barrierComplete = true;
    })();
    await Promise.resolve();
    expect(barrierComplete).toBe(false);
    expect(downstream).not.toHaveBeenCalled();

    finishConfig?.();
    await barrier;

    const service = readDoomMcpProjectionService(root);
    expect(service?.sessionId).toBe('session-1');
    expect(service?.generation).toMatch(/:mcp-projection$/u);
    expect(service?.getSnapshot()).toEqual(mocks.harness.mcpProjection);
    expect(Object.isFrozen(service?.getSnapshot())).toBe(true);
    expect(readiness?.read(CONFIG_PACKAGE_ID)).toMatchObject({ state: 'ready' });
    expect(downstream).toHaveBeenCalledOnce();

    await dispatch('session_shutdown', extensionContext);
    expect(readDoomMcpProjectionService(root)).toBeUndefined();
    expect(() => readiness?.start('late-package', 'late-generation', async () => ({ value: undefined }))).toThrow(
      'disposed',
    );
    await connection.dispose();
  });

  it('replaces the provider with an explicit disabled projection when MCP is switched off', async () => {
    const { pi, dispatch } = host();
    const extensionContext = context();
    await registerConfigExtension(pi);
    const connection = await connectDoomCordisHost(pi, 'config-mcp-reload-test');
    const root = connection.root;

    await dispatch('session_start', extensionContext);
    const firstReadiness = readDoomReadinessCoordinator(root);
    const firstGeneration = readDoomMcpProjectionService(root)?.generation;
    mocks.harness.mcp = false;
    await dispatch('session_start', extensionContext, 'reload');

    const replacementReadiness = readDoomReadinessCoordinator(root);
    const replacement = readDoomMcpProjectionService(root);
    expect(replacementReadiness).not.toBe(firstReadiness);
    expect(replacement?.generation).not.toBe(firstGeneration);
    expect(replacement?.getSnapshot()).toMatchObject({
      enabled: false,
      repoRoot: '/repo',
      stagingDirectory: '/run/current',
      sources: [],
    });
    expect(() => firstReadiness?.start('late-package', 'late-generation', async () => ({ value: undefined }))).toThrow(
      'disposed',
    );

    await dispatch('session_shutdown', extensionContext);
    expect(readDoomMcpProjectionService(root)).toBeUndefined();
    await connection.dispose();
  });

  it('fails closed for a legacy harness that has no file-only projection', async () => {
    const { pi, dispatch } = host();
    const extensionContext = context();
    mocks.harness.mcpProjection = undefined;
    await registerConfigExtension(pi);
    const connection = await connectDoomCordisHost(pi, 'config-mcp-legacy-test');

    await dispatch('session_start', extensionContext);

    expect(readDoomMcpProjectionService(connection.root)?.getSnapshot()).toMatchObject({
      enabled: false,
      repoRoot: '/repo',
      stagingDirectory: '/run/current',
      sources: [],
    });

    await dispatch('session_shutdown', extensionContext);
    await connection.dispose();
  });

  it('reports a failed Config generation once and rejects the session barrier', async () => {
    mocks.createConfigContext.mockRejectedValueOnce(new Error('config read failed'));
    const { pi, dispatch } = host();
    const extensionContext = context();
    await registerConfigExtension(pi);
    const connection = await connectDoomCordisHost(pi, 'config-mcp-failure-test');

    await expect(dispatch('session_start', extensionContext)).rejects.toThrow('config read failed');

    expect(readDoomReadinessCoordinator(connection.root)?.read(CONFIG_PACKAGE_ID)).toMatchObject({
      state: 'failed',
    });
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('config read failed'), 'warning');

    await dispatch('session_shutdown', extensionContext);
    await connection.dispose();
  });
});
