import {
  createDoomReadinessCoordinator,
  DOOM_READINESS_SERVICE,
} from '@agimon-ai/doompi-extension-contracts/readiness';
import { DOOM_UI_HUB_SERVICE, type DoomUiHubService } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const extensionMocks = vi.hoisted(() => ({
  createCordisRoot: (): unknown => undefined,
  prepareCordisRoot: vi.fn(),
  configDispose: vi.fn(),
  configUpdate: vi.fn(),
  createContainer: vi.fn(),
  footerDispose: vi.fn(),
  footerUpdate: vi.fn(),
  leaderDispose: vi.fn(),
  leaderUpdate: vi.fn(),
  refresh: vi.fn(async () => undefined),
  registerConfig: vi.fn(),
  registerFooter: vi.fn(),
  registerLeader: vi.fn(),
  createVoiceRuntime: vi.fn(),
}));
const cordisRoots: Context[] = [];

function testUiHub(): DoomUiHubService {
  return {
    registerConfig: extensionMocks.registerConfig,
    registerFooter: extensionMocks.registerFooter,
    registerLeader: extensionMocks.registerLeader,
    registerLeaderActions: vi.fn(),
  } as unknown as DoomUiHubService;
}

vi.mock('../src/controllers/voice', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/controllers/voice')>()),
  createVoiceRuntime: extensionMocks.createVoiceRuntime,
}));
vi.mock('../src/services/voiceDependencies', () => ({ createVoiceDependencies: extensionMocks.createContainer }));
vi.mock('../src/controllers/voiceConfig', () => ({
  VoiceConfigController: class {
    readonly refresh = extensionMocks.refresh;
    sections(): readonly [] {
      return [];
    }
    handlers(): Record<string, never> {
      return {};
    }
    reportError(): void {}
  },
}));

import { voicePiExtension as composedVoiceExtension } from '../src/extensions/pi';

async function voicePiExtension(pi: ExtensionAPI): Promise<void> {
  Object.assign(pi, { registerTool: vi.fn(), registerCommand: vi.fn() });
  const root = extensionMocks.createCordisRoot() as Context;
  await extensionMocks.prepareCordisRoot(root);
  const fiber = root.plugin((context) => composedVoiceExtension.install(context, pi));
  try {
    await fiber;
  } catch (error) {
    await fiber.dispose();
    throw error;
  }
  pi.on('session_shutdown', () => fiber.dispose());
}
import { voiceLeaderBindings } from '../src/controllers/voice';

beforeEach(() => {
  extensionMocks.createVoiceRuntime.mockReturnValue({ tools: [], commands: [], events: {} });
  extensionMocks.createCordisRoot = () => {
    const root = new Context();
    cordisRoots.push(root);
    return root;
  };
  extensionMocks.prepareCordisRoot.mockImplementation(async (root: Context) => {
    await root.plugin((context) => context.provide(DOOM_UI_HUB_SERVICE, testUiHub()));
  });
  extensionMocks.createContainer.mockImplementation(() => ({
    get: () => ({
      load: () => undefined,
      resolve: () => '/bin/tool',
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    }),
  }));
  extensionMocks.registerFooter.mockReturnValue({
    update: extensionMocks.footerUpdate,
    dispose: extensionMocks.footerDispose,
  });
  extensionMocks.registerLeader.mockReturnValue({
    update: extensionMocks.leaderUpdate,
    dispose: extensionMocks.leaderDispose,
  });
  extensionMocks.registerConfig.mockReturnValue({
    update: extensionMocks.configUpdate,
    dispose: extensionMocks.configDispose,
  });
});

afterEach(async () => {
  await Promise.allSettled(cordisRoots.splice(0).map((root) => root.fiber.dispose()));
  vi.clearAllMocks();
});

describe('standard Voice extension', () => {
  it('installs the complete runtime and awaits idempotent package-local cleanup', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    };

    await voicePiExtension(pi as never);

    expect(extensionMocks.registerFooter).toHaveBeenCalledWith({
      source: '@agimon-ai/doompi-voice',
      id: 'voice-activity',
      order: 30,
    });
    expect(extensionMocks.createVoiceRuntime).toHaveBeenCalledOnce();
    const runtimeCall = extensionMocks.createVoiceRuntime.mock.calls[0];
    expect(runtimeCall?.[0]).toBe(pi);
    const runtimeOptions = runtimeCall?.[1] as
      | { footer?: { update(value: unknown): void; dispose(): void }; dependencies?: unknown }
      | undefined;
    runtimeOptions?.footer?.update({ value: 'activity' });
    expect(extensionMocks.footerUpdate).toHaveBeenCalledWith({ value: 'activity' });
    expect(runtimeOptions?.dependencies).toBeDefined();
    // Manual dictation is SPC v m. Autonomous voice remains the `e` toggle and
    // republishes the exit variant through the leader proxy when capture starts.
    expect(extensionMocks.registerLeader).toHaveBeenCalledWith(
      expect.objectContaining({
        bindings: expect.arrayContaining([
          expect.objectContaining({
            id: 'voice.toggle',
            path: expect.arrayContaining([expect.objectContaining({ key: 'm', label: 'manual' })]),
            command: { name: 'voice' },
          }),
          expect.objectContaining({
            id: 'voice.auto-toggle',
            path: expect.arrayContaining([expect.objectContaining({ key: 'e', label: 'enter' })]),
            command: { name: 'voice-auto' },
          }),
        ]),
      }),
    );
    const runtimeLeader = (runtimeCall?.[1] as { leader?: { update(bindings: readonly unknown[]): void } } | undefined)
      ?.leader;
    runtimeLeader?.update(voiceLeaderBindings(true));
    expect(extensionMocks.leaderUpdate).toHaveBeenCalledWith(voiceLeaderBindings(true));

    await handlers.get('session_start')?.();
    expect(extensionMocks.refresh).toHaveBeenCalledOnce();
    expect(extensionMocks.configUpdate).toHaveBeenCalledOnce();

    await handlers.get('session_shutdown')?.();
    await handlers.get('session_shutdown')?.();
    await handlers.get('session_start')?.();
    expect(extensionMocks.refresh).toHaveBeenCalledOnce();
    expect(extensionMocks.configDispose).toHaveBeenCalledOnce();
    expect(extensionMocks.leaderDispose).toHaveBeenCalledOnce();
    expect(extensionMocks.footerDispose).toHaveBeenCalledOnce();
  });

  it('does not publish a stale configuration refresh after disposal', async () => {
    let finishRefresh: (() => void) | undefined;
    extensionMocks.refresh.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishRefresh = () => resolve(undefined);
        }),
    );
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    };
    await voicePiExtension(pi as never);

    const refresh = Promise.resolve(handlers.get('session_start')?.());
    await handlers.get('session_shutdown')?.();
    finishRefresh?.();
    await refresh;

    expect(extensionMocks.configUpdate).not.toHaveBeenCalled();
  });

  it('drops and recreates optional UI registrations with the provider fiber', async () => {
    let providerFiber: { dispose(): Promise<void> } | undefined;
    extensionMocks.prepareCordisRoot.mockImplementationOnce(async (root: Context) => {
      const fiber = root.plugin((context) => context.provide(DOOM_UI_HUB_SERVICE, testUiHub()));
      providerFiber = fiber;
      await fiber;
    });
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = { on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler) };

    await voicePiExtension(pi as never);
    const runtimeOptions = extensionMocks.createVoiceRuntime.mock.calls[0]?.[1] as
      | { footer?: { update(value: unknown): void } }
      | undefined;
    runtimeOptions?.footer?.update({ phase: 'first' });
    expect(extensionMocks.footerUpdate).toHaveBeenCalledWith({ phase: 'first' });

    await providerFiber?.dispose();
    expect(extensionMocks.footerDispose).toHaveBeenCalledOnce();
    expect(extensionMocks.leaderDispose).toHaveBeenCalledOnce();
    expect(extensionMocks.configDispose).toHaveBeenCalledOnce();
    runtimeOptions?.footer?.update({ phase: 'missing' });
    expect(extensionMocks.footerUpdate).toHaveBeenCalledOnce();

    const root = cordisRoots.at(-1);
    if (!root) throw new Error('Voice test Cordis root is unavailable.');
    const replacement = root.plugin((context) => context.provide(DOOM_UI_HUB_SERVICE, testUiHub()));
    await replacement;
    expect(extensionMocks.registerFooter).toHaveBeenCalledTimes(2);
    runtimeOptions?.footer?.update({ phase: 'replacement' });
    expect(extensionMocks.footerUpdate).toHaveBeenLastCalledWith({ phase: 'replacement' });

    await handlers.get('session_shutdown')?.();
    expect(extensionMocks.footerDispose).toHaveBeenCalledTimes(2);
  });

  it('starts configuration readiness without blocking Pi and gates dependent work', async () => {
    let finishRefresh: (() => void) | undefined;
    extensionMocks.refresh.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishRefresh = () => resolve(undefined);
        }),
    );
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
    };
    const sessionManager = { getSessionId: () => 'voice-ready' };
    const context = { sessionManager } as unknown as ExtensionContext;
    const coordinator = createDoomReadinessCoordinator();

    await voicePiExtension(pi as never);
    const runtimeOptions = extensionMocks.createVoiceRuntime.mock.calls[0]?.[1] as
      | { waitUntilConfigured?: (ctx: ExtensionContext, signal?: AbortSignal) => Promise<void> }
      | undefined;
    await expect(
      runtimeOptions?.waitUntilConfigured?.({ sessionManager: { getSessionId: () => 'not-started' } } as never),
    ).resolves.toBeUndefined();
    cordisRoots.at(-1)?.provide(DOOM_READINESS_SERVICE, coordinator);

    await handlers.get('session_start')?.({}, context);
    await vi.waitFor(() => expect(extensionMocks.refresh).toHaveBeenCalledOnce());
    await handlers.get('session_start')?.({}, context);
    await Promise.resolve();
    expect(extensionMocks.refresh).toHaveBeenCalledOnce();
    await expect(
      runtimeOptions?.waitUntilConfigured?.({ sessionManager: { getSessionId: () => 'stale-session' } } as never),
    ).rejects.toThrow('stale Pi session');
    const aborted = new AbortController();
    aborted.abort(new Error('voice command cancelled'));
    await expect(runtimeOptions?.waitUntilConfigured?.(context, aborted.signal)).rejects.toThrow(
      'voice command cancelled',
    );
    let dependentFinished = false;
    const dependent = runtimeOptions?.waitUntilConfigured?.(context).then(() => {
      dependentFinished = true;
    });
    await Promise.resolve();
    expect(dependentFinished).toBe(false);

    finishRefresh?.();
    await dependent;
    expect(dependentFinished).toBe(true);
    expect(extensionMocks.refresh).toHaveBeenCalledTimes(2);
    expect(extensionMocks.configUpdate).toHaveBeenCalledOnce();

    await handlers.get('session_shutdown')?.({}, context);
    await coordinator.dispose();
  });

  it('creates a fresh Cordis root and resource dependencies for every factory activation', async () => {
    const firstHandlers = new Map<string, (...args: unknown[]) => unknown>();
    const secondHandlers = new Map<string, (...args: unknown[]) => unknown>();
    const firstPi = {
      on: (name: string, handler: (...args: unknown[]) => unknown) => firstHandlers.set(name, handler),
    };
    const secondPi = {
      on: (name: string, handler: (...args: unknown[]) => unknown) => secondHandlers.set(name, handler),
    };

    await voicePiExtension(firstPi as never);
    await voicePiExtension(secondPi as never);

    const firstRoot = extensionMocks.createVoiceRuntime.mock.calls[0]?.[0];
    const secondRoot = extensionMocks.createVoiceRuntime.mock.calls[1]?.[0];
    expect(firstRoot).toBeDefined();
    expect(secondRoot).toBeDefined();
    expect(secondRoot).not.toBe(firstRoot);
    expect(extensionMocks.createContainer).toHaveBeenCalledTimes(2);
    await firstHandlers.get('session_shutdown')?.();
    await secondHandlers.get('session_shutdown')?.();
    expect(extensionMocks.footerDispose).toHaveBeenCalledTimes(2);
  });

  it('rolls back already-owned resources when runtime installation fails', async () => {
    extensionMocks.createVoiceRuntime.mockImplementationOnce(() => {
      throw new Error('runtime failed');
    });
    const pi = { on: vi.fn() };

    await expect(voicePiExtension(pi as never)).rejects.toThrow('runtime failed');

    expect(extensionMocks.footerDispose).not.toHaveBeenCalled();
    expect(extensionMocks.registerLeader).not.toHaveBeenCalled();
    expect(extensionMocks.registerConfig).not.toHaveBeenCalled();
  });
});
