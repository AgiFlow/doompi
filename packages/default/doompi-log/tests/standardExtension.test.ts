import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  createDoomReadinessCoordinator,
  DOOM_READINESS_SERVICE,
} from '@agimon-ai/doompi-extension-contracts/readiness';
import { DOOM_UI_HUB_SERVICE, type DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycleMocks = vi.hoisted(() => ({
  createCordisRoot: (): unknown => undefined,
  prepareCordisRoot: vi.fn(),
  createTelemetry: vi.fn(),
  leaderDispose: vi.fn(),
  recordEvent: vi.fn(async () => undefined),
  registerLeader: vi.fn(),
  shutdownTelemetry: vi.fn(async () => undefined),
}));
const cordisRoots: Context[] = [];

vi.mock('@agimon-ai/doompi-extension-contracts/cordis-host', () => ({
  connectDoomCordisHost: async () => {
    const root = lifecycleMocks.createCordisRoot() as Context;
    await lifecycleMocks.prepareCordisRoot(root);
    return {
      root,
      runtime: { abiVersion: 1, generation: 'log-test', hostId: 'log-test', mode: 'composed' },
      dispose: async () => undefined,
    };
  },
}));
vi.mock('@agimon-ai/doompi-telemetry', () => ({
  createDoomTelemetry: lifecycleMocks.createTelemetry,
}));

const { doomLogExtension } = await import('../src/adapters/pi/extension.ts');

function createContext(sessionId: string): ExtensionContext {
  return {
    cwd: '/repo',
    mode: 'json',
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

function createPi(): {
  pi: ExtensionAPI;
  handler(name: string): (...args: unknown[]) => unknown;
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    pi: {
      events: {},
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
  lifecycleMocks.createCordisRoot = () => {
    const root = new Context();
    cordisRoots.push(root);
    return root;
  };
  lifecycleMocks.prepareCordisRoot.mockImplementation(async (root: Context) => {
    const hub = {
      registerConfig: vi.fn(),
      registerFooter: vi.fn(),
      registerLeader: lifecycleMocks.registerLeader,
      registerLeaderActions: vi.fn(),
    } as unknown as DoomUiHubService;
    await root.plugin((context) => context.provide(DOOM_UI_HUB_SERVICE, hub));
  });
  lifecycleMocks.createTelemetry.mockImplementation(() => ({
    flush: vi.fn(async () => undefined),
    recordDebug: vi.fn(async () => undefined),
    recordError: vi.fn(async () => undefined),
    recordEvent: lifecycleMocks.recordEvent,
    recordWarning: vi.fn(async () => undefined),
    shutdown: lifecycleMocks.shutdownTelemetry,
    status: () => ({
      serviceName: 'pi',
      backend: 'logsink',
      endpointSource: 'test',
      traces: true,
      fileFallback: false,
    }),
  }));
  lifecycleMocks.registerLeader.mockReturnValue({ update: vi.fn(), dispose: lifecycleMocks.leaderDispose });
});

afterEach(async () => {
  await Promise.allSettled(cordisRoots.splice(0).map((root) => root.fiber.dispose()));
  vi.clearAllMocks();
});

describe('standard Log extension lifecycle', () => {
  it('awaits idempotent disposal and fences retained event callbacks', async () => {
    const fixture = createPi();
    const context = createContext('session-1');
    await doomLogExtension(fixture.pi);
    await fixture.handler('session_start')({ reason: 'startup' }, context);

    await Promise.all([
      Promise.resolve(fixture.handler('session_shutdown')({ reason: 'quit' }, context)),
      Promise.resolve(fixture.handler('session_shutdown')({ reason: 'quit' }, context)),
    ]);
    const eventCount = lifecycleMocks.recordEvent.mock.calls.length;
    await fixture.handler('agent_settled')({}, context);

    expect(lifecycleMocks.shutdownTelemetry).toHaveBeenCalledOnce();
    expect(lifecycleMocks.leaderDispose).toHaveBeenCalledOnce();
    expect(lifecycleMocks.recordEvent).toHaveBeenCalledTimes(eventCount);
  });

  it('starts telemetry without blocking Pi and orders later events behind readiness', async () => {
    let finishStart: (() => void) | undefined;
    lifecycleMocks.recordEvent.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishStart = () => resolve(undefined);
        }),
    );
    const fixture = createPi();
    const context = createContext('session-ready');
    const coordinator = createDoomReadinessCoordinator();
    await doomLogExtension(fixture.pi);
    cordisRoots.at(-1)?.provide(DOOM_READINESS_SERVICE, coordinator);

    expect(fixture.handler('session_start')({ reason: 'startup' }, context)).toBeUndefined();
    await vi.waitFor(() => expect(lifecycleMocks.recordEvent).toHaveBeenCalledOnce());
    expect(fixture.handler('before_agent_start')({ prompt: 'hello', images: [] }, context)).toBeUndefined();
    await Promise.resolve();
    expect(lifecycleMocks.recordEvent).toHaveBeenCalledOnce();

    finishStart?.();
    await vi.waitFor(() => expect(lifecycleMocks.recordEvent).toHaveBeenCalledTimes(2));
    expect(lifecycleMocks.recordEvent).toHaveBeenNthCalledWith(
      2,
      'pi.user_prompt',
      expect.objectContaining({ 'pi.session.id': 'session-ready' }),
    );

    await coordinator.dispose();
    await fixture.handler('session_shutdown')({ reason: 'quit' }, context);
  });

  it('keeps telemetry available when optional leader initialization fails', async () => {
    lifecycleMocks.registerLeader.mockImplementationOnce(() => {
      throw new Error('leader failed');
    });
    const fixture = createPi();

    await expect(doomLogExtension(fixture.pi)).resolves.toBeUndefined();
    const context = createContext('headless');
    await fixture.handler('session_start')({ reason: 'startup' }, context);
    await fixture.handler('session_shutdown')({ reason: 'quit' }, context);

    expect(lifecycleMocks.createTelemetry).toHaveBeenCalledOnce();
  });

  it('creates independent telemetry for every factory recreation', async () => {
    const first = createPi();
    const second = createPi();
    const firstContext = createContext('first');
    const secondContext = createContext('second');

    await doomLogExtension(first.pi);
    await doomLogExtension(second.pi);
    await first.handler('session_start')({ reason: 'startup' }, firstContext);
    await second.handler('session_start')({ reason: 'startup' }, secondContext);
    await first.handler('session_shutdown')({ reason: 'quit' }, firstContext);
    await second.handler('session_shutdown')({ reason: 'quit' }, secondContext);

    expect(lifecycleMocks.createTelemetry).toHaveBeenCalledTimes(2);
    expect(lifecycleMocks.shutdownTelemetry).toHaveBeenCalledTimes(2);
    expect(lifecycleMocks.leaderDispose).toHaveBeenCalledTimes(2);
  });
});
