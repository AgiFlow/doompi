import {
  DOOM_CORDIS_SESSION_SERVICE,
  type DoomCordisSessionService,
} from '@agimon-ai/doompi-extension-contracts/cordis-host';
import {
  DOOM_LOOP_LAUNCHERS_SERVICE,
  type DoomLoopLaunchersService,
  type LoopLauncherDefinition,
  requireDoomLoopLaunchers,
} from '@agimon-ai/doompi-extension-contracts/loop-launchers';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  type MinorModeArguments,
  type MinorModeCatalogService,
  type MinorModeOwnerDefinition,
} from '@agimon-ai/doompi-extension-contracts/mode';
import { DOOM_UI_HUB_SERVICE, type DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { Context, type Fiber } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installLoopRuntime, loopExtension } from '../src/adapters/pi/extension.ts';
import { STATUS_KEY } from '../src/adapters/pi/loopConstants.ts';
import { LIST_COMMAND_NAME, START_COMMAND_NAME } from '../src/schemas/loopCommands.ts';

type CommandDefinition = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };
type EventListener = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;

interface MountedLauncher {
  dispose(): Promise<void>;
}

interface Harness {
  readonly commands: Map<string, CommandDefinition>;
  readonly context: ExtensionContext;
  readonly editor: ReturnType<typeof vi.fn>;
  readonly input: ReturnType<typeof vi.fn>;
  readonly modeUpdate: ReturnType<typeof vi.fn>;
  readonly notify: ReturnType<typeof vi.fn>;
  readonly registerLeader: ReturnType<typeof vi.fn>;
  readonly select: ReturnType<typeof vi.fn>;
  readonly sendUserMessage: ReturnType<typeof vi.fn>;
  readonly setStatus: ReturnType<typeof vi.fn>;
  activeLaunchers(): DoomLoopLaunchersService | undefined;
  endSession(): Promise<void>;
  invokeMode(actionId: string, argumentsValue: MinorModeArguments): Promise<unknown>;
  mountLauncher(definition: LoopLauncherDefinition): Promise<MountedLauncher>;
  shutdown(): Promise<void>;
  startSession(context?: ExtensionContext): Promise<void>;
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

async function harness(sessionId: string, mode: ExtensionContext['mode'] = 'print', hasUI = true): Promise<Harness> {
  const commands = new Map<string, CommandDefinition>();
  const listeners = new Map<string, EventListener>();
  const notify = vi.fn();
  const setStatus = vi.fn();
  const select = vi.fn(async (_title: string, options: readonly string[]) => options[0]);
  const editor = vi.fn(async () => 'Check the current status.');
  const input = vi.fn(async () => '60');
  const sendUserMessage = vi.fn();
  const context = {
    mode,
    ...(hasUI ? { ui: { notify, setStatus, select, editor, input } } : {}),
    isIdle: () => true,
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
  const registerCommand = vi.fn((name: string, definition: CommandDefinition) => commands.set(name, definition));
  const pi = {
    events: testBus(),
    registerCommand,
    sendUserMessage,
    on: vi.fn((event: string, listener: EventListener) => listeners.set(event, listener)),
  } as unknown as ExtensionAPI;

  const modeUpdate = vi.fn();
  const modeDispose = vi.fn();
  let modeDefinition: MinorModeOwnerDefinition<ExtensionContext> | undefined;
  const modeService = {
    generation: 'loop-mode-test',
    registerOwner: vi.fn((definition: MinorModeOwnerDefinition<ExtensionContext>) => {
      modeDefinition = definition;
      return {
        getState: () => definition.initialState,
        publish: modeUpdate,
        dispose: modeDispose,
      };
    }),
  } as unknown as MinorModeCatalogService;
  const registerLeader = vi.fn(() => ({ dispose: vi.fn() }));
  const uiHub = { registerLeader } as unknown as DoomUiHubService;

  const cordis = new Context();
  cordis.provide(DOOM_MINOR_MODE_CATALOG_SERVICE, modeService);
  cordis.provide(DOOM_UI_HUB_SERVICE, uiHub);
  installLoopRuntime(cordis, pi);

  let activeService: DoomLoopLaunchersService | undefined;
  cordis.inject([DOOM_LOOP_LAUNCHERS_SERVICE], (serviceContext) => {
    const binding = requireDoomLoopLaunchers(serviceContext);
    activeService = binding;
    return () => {
      if (activeService === binding) activeService = undefined;
    };
  });

  let sessionFiber: Fiber | undefined;
  let sessionSequence = 0;
  const startSession = async (nextContext = context): Promise<void> => {
    await sessionFiber?.dispose();
    const service: DoomCordisSessionService = Object.freeze({
      sessionId: nextContext.sessionManager.getSessionId(),
      generation: `loop-host-session:${++sessionSequence}`,
      reason: 'startup',
      context: nextContext,
    });
    sessionFiber = cordis.plugin((ctx: Context) => ctx.provide(DOOM_CORDIS_SESSION_SERVICE, service));
    await sessionFiber.await();
    await vi.waitFor(() => expect(activeService).toBeDefined());
  };
  const endSession = async (): Promise<void> => {
    await sessionFiber?.dispose();
    sessionFiber = undefined;
    await vi.waitFor(() => expect(activeService).toBeUndefined());
  };

  await vi.waitFor(() => expect(registerLeader).toHaveBeenCalledOnce());
  expect(modeDefinition).toBeDefined();

  return {
    commands,
    context,
    editor,
    input,
    modeUpdate,
    notify,
    registerLeader,
    select,
    sendUserMessage,
    setStatus,
    activeLaunchers: () => activeService,
    endSession,
    async invokeMode(actionId, argumentsValue) {
      if (!modeDefinition) throw new Error('Expected the Loop minor-mode definition.');
      return modeDefinition.handleAction(actionId, argumentsValue, {
        context,
        operationId: 'loop-mode-test-operation',
        sessionKind: mode === 'tui' ? 'tui' : 'headless',
        signal: new AbortController().signal,
      });
    },
    async mountLauncher(definition) {
      const consumer = cordis.plugin((consumerContext: Context) => {
        consumerContext.inject([DOOM_LOOP_LAUNCHERS_SERVICE], (serviceContext) => {
          const registration = requireDoomLoopLaunchers(serviceContext).register(definition);
          return () => registration.dispose('Loop launcher consumer disposed.');
        });
      });
      await consumer.await();
      await vi.waitFor(() => expect(activeService?.listLaunchers().some(({ id }) => id === definition.id)).toBe(true));
      return { dispose: () => consumer.dispose() };
    },
    shutdown: () => cordis.fiber.dispose(),
    startSession,
  };
}

describe('doom loop extension', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registers stable commands and direct UI contributions', async () => {
    const extension = await harness('extension-registration');

    expect([...extension.commands.keys()]).toEqual([START_COMMAND_NAME, LIST_COMMAND_NAME]);
    expect(extension.registerLeader).toHaveBeenCalledWith(
      expect.objectContaining({
        bindings: [
          expect.objectContaining({
            path: [expect.objectContaining({ key: 'l' }), expect.objectContaining({ key: 's' })],
          }),
          expect.objectContaining({
            path: [expect.objectContaining({ key: 'l' }), expect.objectContaining({ key: 'l' })],
          }),
        ],
      }),
    );
    await extension.shutdown();
  });

  it.each([
    { mode: 'print' as const, hasUI: false },
    { mode: 'json' as const, hasUI: false },
    { mode: 'rpc' as const, hasUI: false },
    { mode: 'tui' as const, hasUI: true },
  ])('keeps $mode session lifecycle safe with or without a TUI', async ({ mode, hasUI }) => {
    const extension = await harness(`extension-mode-${mode}`, mode, hasUI);

    await expect(extension.startSession()).resolves.toBeUndefined();
    await expect(extension.shutdown()).resolves.toBeUndefined();
  });

  it('clears the stable command binding when its session provider unloads', async () => {
    const extension = await harness('extension-provider-loss');
    await extension.startSession();
    await extension.endSession();

    await extension.commands.get(START_COMMAND_NAME)?.handler('', extension.context);

    expect(extension.select).not.toHaveBeenCalled();
    expect(extension.activeLaunchers()).toBeUndefined();
    await extension.shutdown();
  });

  it('replaces the session-owned service without duplicating the built-in launcher', async () => {
    const extension = await harness('extension-repeated-start');
    await extension.startSession();
    const firstGeneration = extension.activeLaunchers()?.generation;
    await extension.startSession();

    expect(extension.activeLaunchers()?.generation).not.toBe(firstGeneration);
    expect(extension.activeLaunchers()?.listLaunchers()).toEqual([
      expect.objectContaining({ id: 'doompi.default', label: 'Default loop' }),
    ]);
    await extension.shutdown();
  });

  it('starts the built-in default launcher and updates aggregate status', async () => {
    const extension = await harness('extension-default-start');
    await extension.startSession();

    await extension.commands.get(START_COMMAND_NAME)?.handler('', extension.context);

    expect(extension.select).toHaveBeenCalledWith('Start loop', ['Default loop']);
    expect(extension.editor).toHaveBeenCalledWith('Loop prompt', '');
    expect(extension.input).toHaveBeenCalledWith('Loop interval in seconds', 'Default: 300s');
    expect(extension.sendUserMessage).toHaveBeenCalledWith('Check the current status.');
    expect(extension.notify).toHaveBeenCalledWith('Default loop started.', 'info');
    expect(extension.setStatus).toHaveBeenCalledWith(STATUS_KEY, 'loops: 1');
    expect(extension.modeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ activation: 'active', detail: '1 active' }),
    );
    await extension.shutdown();
  });

  it('routes minor-mode actions through the active session service', async () => {
    const extension = await harness('extension-mode-actions');
    await extension.startSession();

    await expect(
      extension.invokeMode('start', { launcherId: 'doompi.default', instanceId: 'mode-instance' }),
    ).resolves.toEqual({ message: "Loop 'mode-instance' started." });
    await expect(extension.invokeMode('stop', { instanceId: 'mode-instance', reason: 'mode test' })).resolves.toEqual({
      message: 'Loop stopped.',
    });
    await expect(extension.invokeMode('unknown', {})).rejects.toThrow('Unknown loop mode action');
    await extension.endSession();
    await expect(extension.invokeMode('start', { launcherId: 'doompi.default' })).rejects.toThrow(
      'unavailable for the active session',
    );
    await extension.shutdown();
  });

  it('reactively mounts an external launcher and rebinds it after session replacement', async () => {
    const extension = await harness('extension-external');
    await extension.startSession();
    const stop = vi.fn();
    const external = await extension.mountLauncher({
      id: 'example',
      source: 'test',
      label: 'Aardvark loop',
      launch: async ({ instanceId }) => ({ instanceId, label: 'Example instance', stop }),
    });

    await extension.commands.get(START_COMMAND_NAME)?.handler('', extension.context);

    expect(extension.select).toHaveBeenCalledWith('Start loop', ['Aardvark loop', 'Default loop']);
    expect(extension.notify).toHaveBeenCalledWith('Example instance started.', 'info');
    await extension.startSession();
    expect(stop).toHaveBeenCalledOnce();
    expect(extension.activeLaunchers()?.listLaunchers()).toEqual([
      expect.objectContaining({ id: 'example' }),
      expect.objectContaining({ id: 'doompi.default' }),
    ]);
    await external.dispose();
    await extension.shutdown();
  });

  it('reports launcher failures and keeps the session usable', async () => {
    const extension = await harness('extension-failure');
    await extension.startSession();
    const external = await extension.mountLauncher({
      id: 'failure',
      source: 'test',
      label: 'A failure loop',
      launch: async () => Promise.reject(new Error('input failed')),
    });

    await extension.commands.get(START_COMMAND_NAME)?.handler('', extension.context);

    expect(extension.notify).toHaveBeenCalledWith('Loop could not start: input failed', 'error');
    await external.dispose();
    await extension.shutdown();
  });

  it('opens the list command and clears aggregate status on provider loss', async () => {
    const extension = await harness('extension-list');
    await extension.startSession();

    await extension.commands.get(LIST_COMMAND_NAME)?.handler('', extension.context);
    await extension.endSession();

    expect(extension.select).toHaveBeenCalledWith('Stop loop scheduling', []);
    expect(extension.setStatus).toHaveBeenLastCalledWith(STATUS_KEY, undefined);
    expect(extension.modeUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ activation: 'inactive' }));
    await extension.shutdown();
  });

  it('keeps the standard factory shutdown idempotent', async () => {
    const listeners = new Map<string, EventListener[]>();
    const pi = {
      events: testBus(),
      registerCommand: vi.fn(),
      sendUserMessage: vi.fn(),
      on: vi.fn((event: string, listener: EventListener) => {
        const current = listeners.get(event) ?? [];
        current.push(listener);
        listeners.set(event, current);
      }),
    } as unknown as ExtensionAPI;
    await loopExtension(pi);

    const shutdown = (): Promise<unknown[]> =>
      Promise.all(
        listeners.get('session_shutdown')?.map((listener) => Promise.resolve(listener({}, {} as ExtensionContext))) ??
          [],
      );
    await shutdown();
    await shutdown();
  });
});
