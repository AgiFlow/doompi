import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { DOOM_UI_HUB_SERVICE, type DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycleMocks = vi.hoisted(() => ({
  createTelemetry: vi.fn(),
  createCordisRoot: vi.fn(),
  footerDispose: vi.fn(),
  footerUpdate: vi.fn(),
  prepareCordisRoot: vi.fn(),
  registerFooter: vi.fn(),
  telemetryShutdown: vi.fn(async () => undefined),
}));

const cordisRoots: Context[] = [];

vi.mock('@agimon-ai/doompi-extension-contracts/cordis-host', () => ({
  connectDoomCordisHost: async () => {
    const root = lifecycleMocks.createCordisRoot() as Context;
    await lifecycleMocks.prepareCordisRoot(root);
    return {
      root,
      runtime: { abiVersion: 1, generation: 'autocompact-test', hostId: 'autocompact-test', mode: 'composed' },
      dispose: async () => undefined,
    };
  },
}));
vi.mock('../src/adapters/telemetry/logSinkTelemetry.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/adapters/telemetry/logSinkTelemetry.ts')>()),
  createAutocompactTelemetry: lifecycleMocks.createTelemetry,
}));

const { autocompactExtension } = await import('../src/adapters/pi/extension.ts');

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

function createPi(): {
  pi: ExtensionAPI;
  handler(name: string): (...args: unknown[]) => unknown;
  appendEntry: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const appendEntry = vi.fn();
  return {
    pi: {
      appendEntry,
      events: testBus(),
      on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    } as unknown as ExtensionAPI,
    handler(name: string) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Missing ${name} handler.`);
      return handler;
    },
    appendEntry,
  };
}

beforeEach(() => {
  lifecycleMocks.createCordisRoot.mockImplementation(() => {
    const root = new Context();
    cordisRoots.push(root);
    return root;
  });
  lifecycleMocks.prepareCordisRoot.mockImplementation(async (root: Context) => {
    const hub = {
      registerConfig: vi.fn(),
      registerFooter: lifecycleMocks.registerFooter,
      registerLeader: vi.fn(),
      registerLeaderActions: vi.fn(),
    } as unknown as DoomUiHubService;
    await root.plugin((context) => context.provide(DOOM_UI_HUB_SERVICE, hub));
  });
  lifecycleMocks.createTelemetry.mockReturnValue({
    flush: vi.fn(async () => undefined),
    recordError: vi.fn(async () => undefined),
    recordEvent: vi.fn(async () => undefined),
    recordWarning: vi.fn(async () => undefined),
    runInSpan: vi.fn(async (_name: string, _attributes: object, callback: () => Promise<unknown>) => callback()),
    shutdown: lifecycleMocks.telemetryShutdown,
  });
  lifecycleMocks.registerFooter.mockReturnValue({
    dispose: lifecycleMocks.footerDispose,
    update: lifecycleMocks.footerUpdate,
  });
});

afterEach(async () => {
  await Promise.allSettled(cordisRoots.splice(0).map((root) => root.fiber.dispose()));
  vi.clearAllMocks();
});

describe('standard Autocompact extension lifecycle', () => {
  it('awaits idempotent disposal and fences callbacks retained by Pi', async () => {
    const fixture = createPi();
    await autocompactExtension(fixture.pi);

    await Promise.all([
      Promise.resolve(fixture.handler('session_shutdown')()),
      Promise.resolve(fixture.handler('session_shutdown')()),
    ]);
    await fixture.handler('session_start')({}, {});

    expect(lifecycleMocks.footerDispose).toHaveBeenCalledOnce();
    expect(lifecycleMocks.telemetryShutdown).toHaveBeenCalledOnce();
    expect(fixture.appendEntry).not.toHaveBeenCalled();
  });

  it('keeps the package runtime alive when optional footer initialization fails', async () => {
    lifecycleMocks.registerFooter.mockImplementationOnce(() => {
      throw new Error('footer failed');
    });
    const fixture = createPi();

    await expect(autocompactExtension(fixture.pi)).resolves.toBeUndefined();
    await fixture.handler('session_shutdown')();

    expect(lifecycleMocks.telemetryShutdown).toHaveBeenCalledOnce();
  });

  it('creates independent resources for every factory recreation', async () => {
    const first = createPi();
    const second = createPi();

    await autocompactExtension(first.pi);
    await autocompactExtension(second.pi);
    await Promise.resolve(first.handler('session_shutdown')());
    await Promise.resolve(second.handler('session_shutdown')());

    expect(lifecycleMocks.createTelemetry).toHaveBeenCalledTimes(2);
    expect(lifecycleMocks.registerFooter).toHaveBeenCalledTimes(2);
    expect(lifecycleMocks.telemetryShutdown).toHaveBeenCalledTimes(2);
  });
});
