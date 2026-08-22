import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { DOOM_UI_HUB_SERVICE, type DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  clearTimeline: vi.fn(async () => undefined),
  createCordisRoot: vi.fn(),
  createContainer: vi.fn(),
  leaderDispose: vi.fn(),
  recordEvent: vi.fn(async () => undefined),
  prepareCordisRoot: vi.fn(),
  registerLeader: vi.fn(),
  shutdownTelemetry: vi.fn(async () => undefined),
  startTracking: vi.fn(async () => undefined),
  endTracking: vi.fn(async () => undefined),
}));

const cordisRoots: Context[] = [];

vi.mock('../src/container/index.ts', () => ({
  createFileEditContainer: runtimeMocks.createContainer,
}));
vi.mock('@agimon-ai/doompi-telemetry', () => ({
  createDoomTelemetry: () => ({
    recordEvent: runtimeMocks.recordEvent,
    shutdown: runtimeMocks.shutdownTelemetry,
  }),
}));
vi.mock('@agimon-ai/doompi-extension-contracts/cordis-host', () => ({
  connectDoomCordisHost: async () => {
    const root = runtimeMocks.createCordisRoot() as Context;
    await runtimeMocks.prepareCordisRoot(root);
    return {
      root,
      runtime: { abiVersion: 1, generation: 'file-edit-test', hostId: 'file-edit-test', mode: 'composed' },
      dispose: async () => undefined,
    };
  },
}));

const { fileEditExtension } = await import('../src/adapters/pi/extension.ts');

interface TestPi {
  pi: ExtensionAPI;
  handler(name: string): (...args: unknown[]) => unknown;
}

function testBus() {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    emit(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    on(event: string, handler: (payload: unknown) => void) {
      const listeners = handlers.get(event) ?? new Set();
      listeners.add(handler);
      handlers.set(event, listeners);
      return () => listeners.delete(handler);
    },
  };
}

function createPi(): TestPi {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    pi: {
      events: testBus(),
      on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
      registerCommand: vi.fn(),
    } as unknown as ExtensionAPI,
    handler(name: string) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Missing ${name} handler.`);
      return handler;
    },
  };
}

beforeEach(() => {
  runtimeMocks.createCordisRoot.mockImplementation(() => {
    const root = new Context();
    cordisRoots.push(root);
    return root;
  });
  runtimeMocks.prepareCordisRoot.mockImplementation(async (root: Context) => {
    const hub = {
      registerConfig: vi.fn(),
      registerFooter: vi.fn(),
      registerLeader: runtimeMocks.registerLeader,
      registerLeaderActions: vi.fn(),
    } as unknown as DoomUiHubService;
    await root.plugin((context) => context.provide(DOOM_UI_HUB_SERVICE, hub));
  });
  runtimeMocks.createContainer.mockImplementation(() => ({
    paths: {
      sessionKey: (sessionId: string) => sessionId,
      timelinePath: (cwd: string, sessionKey: string) => `${cwd}/${sessionKey}.json`,
    },
    timeline: { initialize: vi.fn(), clear: runtimeMocks.clearTimeline },
    editTracker: { start: runtimeMocks.startTracking, end: runtimeMocks.endTracking },
    workflow: { open: vi.fn(async () => undefined) },
  }));
  runtimeMocks.registerLeader.mockReturnValue({ update: vi.fn(), dispose: runtimeMocks.leaderDispose });
});

afterEach(async () => {
  await Promise.allSettled(cordisRoots.splice(0).map((root) => root.fiber.dispose()));
  vi.clearAllMocks();
  delete process.env.PI_SUBAGENT_CHILD;
});

describe('standard File Edit extension lifecycle', () => {
  it('awaits idempotent cleanup and fences a deferred tracker continuation', async () => {
    let finishTracking: (() => void) | undefined;
    runtimeMocks.startTracking.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishTracking = () => resolve(undefined);
        }),
    );
    const fixture = createPi();
    await fileEditExtension(fixture.pi);
    fixture.handler('session_start')({}, { sessionManager: { getSessionId: () => 'session-1' }, cwd: '/repo' });
    const tracking = Promise.resolve(
      fixture.handler('tool_execution_start')({ toolCallId: 'call-1', toolName: 'edit', args: {} }, { cwd: '/repo' }),
    );

    await Promise.all([
      Promise.resolve(fixture.handler('session_shutdown')()),
      Promise.resolve(fixture.handler('session_shutdown')()),
    ]);
    finishTracking?.();
    await tracking;

    expect(runtimeMocks.clearTimeline).toHaveBeenCalledOnce();
    expect(runtimeMocks.shutdownTelemetry).toHaveBeenCalledOnce();
    expect(runtimeMocks.leaderDispose).toHaveBeenCalledOnce();
    expect(runtimeMocks.recordEvent).not.toHaveBeenCalledWith('doom_file_edit.edit_started', expect.anything());
  });

  it('keeps runtime resources alive when optional leader initialization fails', async () => {
    runtimeMocks.registerLeader.mockImplementationOnce(() => {
      throw new Error('leader failed');
    });
    const fixture = createPi();

    await expect(fileEditExtension(fixture.pi)).resolves.toBeUndefined();
    await fixture.handler('session_shutdown')();

    expect(runtimeMocks.clearTimeline).toHaveBeenCalledOnce();
    expect(runtimeMocks.shutdownTelemetry).toHaveBeenCalledOnce();
  });

  it('recreates independent package resources for a fresh factory', async () => {
    const first = createPi();
    const second = createPi();

    await fileEditExtension(first.pi);
    await fileEditExtension(second.pi);
    await Promise.resolve(first.handler('session_shutdown')());
    await Promise.resolve(second.handler('session_shutdown')());

    expect(runtimeMocks.createContainer).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.shutdownTelemetry).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.leaderDispose).toHaveBeenCalledTimes(2);
  });
});
