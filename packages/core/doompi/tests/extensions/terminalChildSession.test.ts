import { createTerminalPiChildSessionServiceProvider } from '@agimon-ai/doompi-core/terminal-pi-child-session-service';
import type { Provider } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRegistry,
  SessionShutdownEvent,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';

import cordisFinalizerExtension from '../../src/extensions/cordisFinalizer';
import cordisHostExtension from '../../src/extensions/cordisHost';
import terminalChildSessionExtension from '../../src/extensions/terminalChildSession';

const createChildSessions = vi.hoisted(() =>
  vi.fn(() => ({ get: () => ({ close: async () => undefined }), close: async () => undefined })),
);

vi.mock('@agimon-ai/doompi-core/terminal-pi-child-session-service', () => ({
  createTerminalPiChildSessionServiceProvider: createChildSessions,
}));

// The extension builds a child ModelRuntime from the agent directory. Neither
// the runtime nor the files it reads take part in provider collection.
vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-coding-agent')>()),
  getAgentDir: () => '/tmp/doompi-terminal-child-session-test',
  ModelRuntime: { create: async () => ({}) },
}));

type Handler = (event: never, context: ExtensionContext) => unknown;

/** Mutable stand-in for the host registry that Pi extensions register into. */
interface RegistryState {
  ids: string[];
  native: Map<string, Provider>;
  generic: Map<string, Provider>;
}

function provider(id: string): Provider {
  return { id } as unknown as Provider;
}

/**
 * Boots the composed Cordis entries with the terminal child session extension
 * and returns the `providers` thunk it wired into the child session service.
 */
async function setup(state: RegistryState) {
  const busHandlers = new Map<string, Set<(data: unknown) => void>>();
  const lifecycle = new Map<string, Handler[]>();
  const pi = {
    events: {
      emit(channel: string, data: unknown) {
        for (const handler of busHandlers.get(channel) ?? []) handler(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        const handlers = busHandlers.get(channel) ?? new Set();
        handlers.add(handler);
        busHandlers.set(channel, handlers);
        return () => handlers.delete(handler);
      },
    },
    on(name: string, handler: Handler) {
      lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
    },
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => undefined,
  } as unknown as ExtensionAPI;
  const modelRegistry = {
    getRegisteredProviderIds: () => state.ids,
    getRegisteredNativeProvider: (id: string) => state.native.get(id),
    getProvider: (id: string) => state.generic.get(id),
  } as unknown as ModelRegistry;
  const context = {
    cwd: '/repo',
    model: undefined,
    modelRegistry,
    sessionManager: { getSessionId: () => 'session-1' },
  } as unknown as ExtensionContext;
  const dispatch = async (event: SessionStartEvent | SessionShutdownEvent) => {
    for (const handler of lifecycle.get(event.type) ?? []) await handler(event as never, context);
  };

  vi.mocked(createTerminalPiChildSessionServiceProvider).mockClear();
  await cordisHostExtension(pi);
  await terminalChildSessionExtension(pi);
  await cordisFinalizerExtension(pi);
  await dispatch({ type: 'session_start', reason: 'startup' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const providers = vi.mocked(createTerminalPiChildSessionServiceProvider).mock.calls[0]?.[0].providers;
  if (typeof providers !== 'function')
    throw new Error('The terminal child session service received no providers thunk.');
  return {
    providers,
    close: () => dispatch({ type: 'session_shutdown', reason: 'reload' }),
  };
}

describe('terminal child session providers', () => {
  it('prefers the natively registered provider and falls back to the generic registry entry', async () => {
    const native = provider('native-custom');
    const generic = provider('generic-custom');
    const configured = provider('configured-openai');
    const fixture = await setup({
      ids: ['custom', 'openai'],
      native: new Map([['custom', native]]),
      generic: new Map([
        ['custom', generic],
        ['openai', configured],
      ]),
    });
    try {
      expect(fixture.providers()).toEqual([native, configured]);
    } finally {
      await fixture.close();
    }
  });

  it('omits an id that resolves to no provider instead of collecting a hole', async () => {
    const native = provider('native-custom');
    const fixture = await setup({
      ids: ['stale', 'custom'],
      native: new Map([['custom', native]]),
      generic: new Map(),
    });
    try {
      const collected = fixture.providers();
      expect(collected).toEqual([native]);
      expect(collected).not.toContain(undefined);
    } finally {
      await fixture.close();
    }
  });

  it('reads the registry on every call so a late registration is visible', async () => {
    const first = provider('first');
    const late = provider('late');
    const state: RegistryState = {
      ids: ['first'],
      native: new Map([['first', first]]),
      generic: new Map(),
    };
    const fixture = await setup(state);
    try {
      expect(fixture.providers()).toEqual([first]);

      state.ids = ['first', 'late'];
      state.native.set('late', late);
      expect(fixture.providers()).toEqual([first, late]);

      state.ids = [];
      expect(fixture.providers()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});

describe('terminal child session wiring', () => {
  it('resolves providers from the session extension context registry', async () => {
    const fixture = await setup({ ids: [], native: new Map(), generic: new Map() });
    try {
      expect(createTerminalPiChildSessionServiceProvider).toHaveBeenCalledTimes(1);
      expect(vi.mocked(createTerminalPiChildSessionServiceProvider).mock.calls[0]?.[0]).toMatchObject({
        cwd: '/repo',
        providers: expect.any(Function),
        defaultModel: expect.any(Function),
      });
    } finally {
      await fixture.close();
    }
  });
});
