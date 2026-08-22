import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { readDoomHelpService, type DoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import { DOOM_MINOR_MODE_CATALOG_SERVICE } from '@agimon-ai/doompi-extension-contracts/mode';
import { DOOM_UI_HUB_SERVICE } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  activationGetState: vi.fn(() => ({ activation: 'inactive' })),
  activationActivate: vi.fn(async () => ({ activation: 'active' })),
  activationDeactivate: vi.fn(() => ({ activation: 'inactive' })),
  runtimeDispose: vi.fn(),
  modeDispose: vi.fn(),
  modeRegister: vi.fn((..._argumentsValue: unknown[]) => ({ dispose: vi.fn() })),
  uiDispose: vi.fn(),
  uiRegister: vi.fn((..._argumentsValue: unknown[]) => vi.fn()),
  runtimeOptions: undefined as Record<string, unknown> | undefined,
  runtimeService: undefined as DoomHelpService | undefined,
}));

vi.mock('../../../src/container/index.ts', () => ({
  createHelpRuntime: (service: DoomHelpService, options: Record<string, unknown>) => {
    mocks.runtimeService = service;
    mocks.runtimeOptions = options;
    return {
      activation: {
        getState: mocks.activationGetState,
        activate: mocks.activationActivate,
        deactivate: mocks.activationDeactivate,
      },
      dispose: mocks.runtimeDispose,
    };
  },
}));

vi.mock('../../../src/adapters/pi/helpMode.ts', () => ({
  registerHelpModeIntegration: (...argumentsValue: unknown[]) => mocks.modeRegister(...argumentsValue),
  registerHelpUiIntegration: (...argumentsValue: unknown[]) => {
    mocks.uiRegister(...argumentsValue);
    return mocks.uiDispose;
  },
}));

import { helpExtension } from '../../../src/adapters/pi/extension';
import piExtension from '../../../src/exports/extensions/pi.ts';

type LifecycleHandler = (...argumentsValue: unknown[]) => unknown;

interface ExtensionFixture {
  commands: Map<
    string,
    { handler: (args: string, context: { hasUI: boolean; ui: { notify(): void } }) => Promise<void> }
  >;
  pi: ExtensionAPI;
  handlers: Map<string, LifecycleHandler[]>;
}

function extensionFixture(): ExtensionFixture {
  const commands = new Map<
    string,
    { handler: (args: string, context: { hasUI: boolean; ui: { notify(): void } }) => Promise<void> }
  >();
  const handlers = new Map<string, LifecycleHandler[]>();
  const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const pi = {
    events: {
      emit(event: string, payload: unknown) {
        for (const handler of eventHandlers.get(event) ?? []) handler(payload);
      },
      on(event: string, handler: (payload: unknown) => void) {
        const listeners = eventHandlers.get(event) ?? new Set();
        listeners.add(handler);
        eventHandlers.set(event, listeners);
        return () => listeners.delete(handler);
      },
    },
    on(event: string, handler: LifecycleHandler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerCommand(name: string, definition: { handler: () => Promise<void> }) {
      commands.set(name, definition);
    },
  };
  return { commands, pi: pi as unknown as ExtensionAPI, handlers };
}

function sessionContext(): ExtensionContext {
  return {
    cwd: '/repo',
    sessionManager: { getSessionId: () => 'help-test-session', getBranch: () => [] },
  } as unknown as ExtensionContext;
}

async function dispatch(
  handlers: Map<string, LifecycleHandler[]>,
  event: string,
  context = sessionContext(),
): Promise<void> {
  for (const handler of handlers.get(event) ?? []) {
    await handler({ type: event, reason: 'startup' }, context);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activationGetState.mockReturnValue({ activation: 'inactive' });
  mocks.activationActivate.mockResolvedValue({ activation: 'active' });
  mocks.modeRegister.mockReturnValue({ dispose: mocks.modeDispose });
  mocks.uiRegister.mockReturnValue(mocks.uiDispose);
  mocks.runtimeOptions = undefined;
  mocks.runtimeService = undefined;
});

describe('standard Help extension', () => {
  it('provides a session-owned Help service and routes the stable command to its activation', async () => {
    const { commands, handlers, pi } = extensionFixture();
    expect(piExtension).toBe(helpExtension);
    await helpExtension(pi);
    const connection = await connectDoomCordisHost(pi, 'help-extension-test');
    const integrations = connection.root.plugin((context) => {
      context.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, {} as never);
      context.provide(DOOM_UI_HUB_SERVICE, {} as never);
    });
    await integrations;

    expect(readDoomHelpService(connection.root)).toBeUndefined();
    await dispatch(handlers, 'session_start');

    const service = readDoomHelpService(connection.root);
    expect(service).toBe(mocks.runtimeService);
    expect(service?.listContributions()).toEqual([
      expect.objectContaining({
        source: '@agimon-ai/doompi-help',
        skills: [expect.objectContaining({ name: 'doompi-use-help' })],
      }),
    ]);
    expect(mocks.modeRegister).toHaveBeenCalledOnce();
    expect(mocks.uiRegister).toHaveBeenCalledOnce();

    await commands.get('doom-help')?.handler('', { hasUI: false, ui: { notify: vi.fn() } });
    expect(mocks.activationActivate).toHaveBeenCalledOnce();

    await dispatch(handlers, 'session_shutdown');
    expect(readDoomHelpService(connection.root)).toBeUndefined();
    await expect(commands.get('doom-help')?.handler('', { hasUI: false, ui: { notify: vi.fn() } })).rejects.toThrow(
      'waiting for the active session service',
    );
    expect(mocks.runtimeDispose).toHaveBeenCalledOnce();
    expect(mocks.modeDispose).toHaveBeenCalledOnce();
    expect(mocks.uiDispose).toHaveBeenCalledOnce();

    await integrations.dispose();
    await connection.dispose();
  });

  it('creates a fresh service for a replacement session generation', async () => {
    const { handlers, pi } = extensionFixture();
    await helpExtension(pi);
    const connection = await connectDoomCordisHost(pi, 'help-reload-test');

    await dispatch(handlers, 'session_start');
    const first = readDoomHelpService(connection.root);
    await dispatch(handlers, 'session_start');
    const replacement = readDoomHelpService(connection.root);

    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(first);
    expect(replacement?.generation).not.toBe(first?.generation);
    expect(mocks.runtimeDispose).toHaveBeenCalledOnce();

    await dispatch(handlers, 'session_shutdown');
    await connection.dispose();
  });
});
