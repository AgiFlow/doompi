import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readHarnessState } from '@agimon-ai/doompi-config/harnessState';
import { provideDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import {
  createDoomHelpService,
  DOOM_HELP_SERVICE,
  type DoomHelpService,
} from '@agimon-ai/doompi-extension-contracts/help';
import {
  DOOM_VOICE_TOOLS_SERVICE,
  createDoomVoiceToolsService,
  type DoomVoiceToolsService,
} from '@agimon-ai/doompi-extension-contracts/voice-tools';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { majorModeExtension } from '../../src/adapters/pi/extension.ts';
import type { MajorModeTelemetry } from '../../src/types/telemetry.ts';
import { bindStubCoordinator } from '../helpers/coordinator.ts';

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

const recorded: string[] = [];
const telemetry: MajorModeTelemetry = {
  recordError: async (event) => {
    recorded.push(event);
  },
  recordEvent: async () => undefined,
};
let disposeConfig: (() => void) | undefined;

function harness() {
  const handlers = new Map<string, Handler>();
  const registerCommand = vi.fn();
  const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
  const events = {
    emit: vi.fn((event: string, value: unknown) => {
      for (const handler of eventHandlers.get(event) ?? []) handler(value);
    }),
    on: vi.fn((event: string, handler: (value: unknown) => void) => {
      const subscriptions = eventHandlers.get(event) ?? new Set();
      subscriptions.add(handler);
      eventHandlers.set(event, subscriptions);
      return () => subscriptions.delete(handler);
    }),
  };
  const pi = {
    registerCommand,
    events,
    on(event: string, handler: Handler) {
      const previous = handlers.get(event);
      handlers.set(event, async (payload, context) => {
        await previous?.(payload, context);
        return handler(payload, context);
      });
    },
    sendUserMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, handlers, registerCommand };
}

async function bindConfig(pi: ExtensionAPI, _ctx: ExtensionContext): Promise<void> {
  const connection = await connectDoomCordisHost(pi, 'major-mode-extension-test');
  const fiber = connection.root.plugin((cordis) => {
    provideDoomConfigContext(cordis, {
      settings: { projectTrust: 'ask' },
      harness: { ...readHarnessState({}), majorMode: 'copilot', domains: ['default'] },
      requiresRelaunch: false,
    });
    const coordinator = bindStubCoordinator(cordis, 'major-mode-factory-session', {
      domains: ['default'],
      majorMode: 'copilot',
      layers: [],
    });
    return () => coordinator.dispose();
  });
  await fiber;
  disposeConfig = () => void fiber.dispose().then(() => connection.dispose());
}

async function bindRuntime(
  pi: ExtensionAPI,
  source: string,
  majorMode: string,
): Promise<{ readonly root: Context; dispose(): Promise<void> }> {
  const connection = await connectDoomCordisHost(pi, source);
  const fiber = connection.root.plugin((cordis) => {
    provideDoomConfigContext(
      cordis,
      {
        settings: { projectTrust: 'ask' },
        harness: { ...readHarnessState({}), majorMode, domains: ['default'] },
        requiresRelaunch: false,
      },
      `${source}:config`,
    );
    const coordinator = bindStubCoordinator(cordis, `${source}:session`, {
      domains: ['default'],
      majorMode,
      layers: [],
    });
    return () => coordinator.dispose();
  });
  await fiber;
  return {
    root: connection.root,
    async dispose() {
      try {
        await fiber.dispose();
      } finally {
        await connection.dispose();
      }
    },
  };
}

async function provideVoiceTools(
  root: Context,
  service: DoomVoiceToolsService<ExtensionContext>,
): Promise<{ dispose(): Promise<void> }> {
  const fiber = root.plugin((cordis) => cordis.provide(DOOM_VOICE_TOOLS_SERVICE, service));
  await fiber;
  return { dispose: () => fiber.dispose() };
}

async function provideHelp(root: Context, service: DoomHelpService): Promise<{ dispose(): Promise<void> }> {
  const fiber = root.plugin((cordis) => cordis.provide(DOOM_HELP_SERVICE, service));
  await fiber;
  return { dispose: () => fiber.dispose() };
}

async function sessionContext(pi: ExtensionAPI, withConfig: boolean) {
  const setStatus = vi.fn();
  const ctx = {
    ui: { setStatus, theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t } },
    sessionManager: { getSessionId: () => 'major-mode-factory-session' },
  } as unknown as ExtensionContext;
  if (withConfig) await bindConfig(pi, ctx);
  return { ctx, setStatus };
}

afterEach(() => {
  disposeConfig?.();
  disposeConfig = undefined;
  recorded.length = 0;
});

describe('major mode Pi factory', () => {
  it('registers the command and the voice tool, and disposes once on shutdown', async () => {
    const { pi, handlers, registerCommand } = harness();

    await majorModeExtension(pi, telemetry);

    expect(registerCommand).toHaveBeenCalledWith('mode', expect.objectContaining({ description: expect.any(String) }));
    const shutdown = handlers.get('session_shutdown');
    expect(shutdown).toBeTypeOf('function');
    // Idempotent: Pi can fire session_shutdown more than once across a reload.
    await (shutdown as unknown as () => Promise<void>)();
    await (shutdown as unknown as () => Promise<void>)();
  });

  it('paints the status line on session start', async () => {
    const { pi, handlers } = harness();
    await majorModeExtension(pi, telemetry);
    const { ctx, setStatus } = await sessionContext(pi, true);

    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);

    expect(setStatus).toHaveBeenCalledWith('doom-major-mode', expect.stringContaining('[copilot]'));
  });

  it('waits for the required config service before painting the status line', async () => {
    const { pi, handlers } = harness();
    await majorModeExtension(pi, telemetry);
    const { ctx, setStatus } = await sessionContext(pi, false);

    const start = handlers.get('session_start')?.({ reason: 'startup' }, ctx);
    await Promise.resolve();
    expect(setStatus).not.toHaveBeenCalled();
    await bindConfig(pi, ctx);
    await start;

    expect(setStatus).toHaveBeenCalledWith('doom-major-mode', expect.stringContaining('[copilot]'));
    expect(recorded).toEqual([]);
  });

  it('clears a lost runtime provider and binds its replacement', async () => {
    const { pi, handlers, registerCommand } = harness();
    await majorModeExtension(pi, telemetry);
    const registered = registerCommand.mock.calls[0]?.[1] as
      | { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
      | undefined;
    if (!registered) throw new Error('the mode command was not registered');
    const setStatus = vi.fn();
    const ctx = {
      mode: 'rpc',
      cwd: '/repo',
      ui: {
        notify: vi.fn(),
        select: vi.fn(async () => undefined),
        setStatus,
        theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      },
      sessionManager: { getSessionId: () => 'major-mode-provider-session' },
    } as unknown as ExtensionContext;

    await expect(registered.handler('', ctx)).rejects.toThrow('waiting for the session config service');

    const first = await bindRuntime(pi, 'major-mode-provider-first', 'copilot');
    await handlers.get('session_start')?.({ reason: 'startup' }, ctx);
    expect(setStatus).toHaveBeenLastCalledWith('doom-major-mode', expect.stringContaining('[copilot]'));

    await first.dispose();
    await expect(registered.handler('', ctx)).rejects.toThrow('waiting for the session config service');
    await handlers.get('session_start')?.({ reason: 'reload' }, ctx);
    expect(recorded).toContain('doom_pi_major_mode.unavailable');
    expect(setStatus).toHaveBeenLastCalledWith('doom-major-mode', expect.stringContaining('major mode unavailable'));

    const second = await bindRuntime(pi, 'major-mode-provider-second', 'minimal');
    try {
      await handlers.get('session_start')?.({ reason: 'startup' }, ctx);
      expect(setStatus).toHaveBeenLastCalledWith('doom-major-mode', expect.stringContaining('[minimal]'));
    } finally {
      await second.dispose();
      await (handlers.get('session_shutdown') as unknown as () => Promise<void>)();
    }
  });

  it('mounts the voice contribution only while a complete voice provider is live', async () => {
    const { pi, handlers } = harness();
    await majorModeExtension(pi, telemetry);
    const runtime = await bindRuntime(pi, 'major-mode-voice-runtime', 'copilot');
    const context = {
      sessionManager: { getSessionId: () => 'major-mode-voice-provider-session' },
    } as unknown as ExtensionContext;
    const firstService = createDoomVoiceToolsService<ExtensionContext>('major-mode-voice-first');
    const firstSession = firstService.bindSession('major-mode-voice-provider-session', context);
    firstSession.setActive(true);
    expect(firstSession.describe().tools).toEqual([]);

    const firstProvider = await provideVoiceTools(runtime.root, firstService);
    expect(firstSession.describe().tools).toEqual([expect.objectContaining({ name: 'major_mode' })]);
    await firstProvider.dispose();
    expect(firstSession.describe().tools).toEqual([]);

    const replacementService = createDoomVoiceToolsService<ExtensionContext>('major-mode-voice-replacement');
    const replacementSession = replacementService.bindSession('major-mode-voice-provider-session', context);
    replacementSession.setActive(true);
    const replacementProvider = await provideVoiceTools(runtime.root, replacementService);
    try {
      expect(replacementSession.describe().tools).toEqual([expect.objectContaining({ name: 'major_mode' })]);
    } finally {
      await replacementProvider.dispose();
      replacementSession.dispose();
      replacementService.dispose();
      firstSession.dispose();
      firstService.dispose();
      await runtime.dispose();
      await (handlers.get('session_shutdown') as unknown as () => Promise<void>)();
    }
  });

  it('registers package-owned Help with a live provider and rebinds its replacement', async () => {
    const { pi, handlers } = harness();
    await majorModeExtension(pi, telemetry);
    const connection = await connectDoomCordisHost(pi, 'major-mode-help-lifecycle-test');
    const firstHelp = createDoomHelpService('major-mode-help-first');
    const firstProvider = await provideHelp(connection.root, firstHelp);

    expect(firstHelp.listContributions()).toEqual([
      {
        source: '@agimon-ai/doompi-major-mode',
        moduleUrl: expect.stringMatching(/extension\.ts$/u),
        skills: [
          {
            name: 'doompi-author-major-mode',
            description:
              "Configure DoomPi default packages, layers, extensions, hook groups, and named major modes. Use when creating or editing ~/.pi/.doom/modes.yaml or a repository's .doom/modes.yaml, choosing a default mode, or diagnosing which behavior a mode activates.",
          },
        ],
      },
    ]);

    await firstProvider.dispose();
    expect(firstHelp.listContributions()).toEqual([]);

    const replacementHelp = createDoomHelpService('major-mode-help-replacement');
    const replacementProvider = await provideHelp(connection.root, replacementHelp);
    try {
      expect(replacementHelp.listContributions()).toEqual([
        expect.objectContaining({
          source: '@agimon-ai/doompi-major-mode',
          skills: [expect.objectContaining({ name: 'doompi-author-major-mode' })],
        }),
      ]);

      await (handlers.get('session_shutdown') as unknown as () => Promise<void>)();
      expect(replacementHelp.listContributions()).toEqual([]);
    } finally {
      await replacementProvider.dispose();
      replacementHelp.dispose();
      firstHelp.dispose();
      await connection.dispose();
    }
  });

  it('resolves the live view through its lazy config loader when the command runs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'major-mode-view-'));
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(root);
    fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.doom', 'modes.yaml'),
      'layers:\n  team: {}\ndefaultMajorMode: copilot\nmajorMode:\n  copilot:\n    description: Full mode.\n    layers: [team]\n',
    );
    const { pi, registerCommand } = harness();
    await majorModeExtension(pi, telemetry);
    const registered = registerCommand.mock.calls[0]?.[1] as
      | { handler: (a: string, c: ExtensionContext) => Promise<void> }
      | undefined;
    if (!registered) throw new Error('the mode command was not registered');
    const handler = registered.handler;
    const select = vi.fn(async () => undefined);
    const ctx = {
      mode: 'rpc',
      cwd: root,
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        select,
        theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
      },
      sessionManager: { getSessionId: () => 'major-mode-view-session' },
    } as unknown as ExtensionContext;
    const connection = await connectDoomCordisHost(pi, 'major-mode-view-test');
    const configFiber = connection.root.plugin((cordis) => {
      provideDoomConfigContext(cordis, {
        settings: { projectTrust: 'ask' },
        harness: { ...readHarnessState({}), root, majorMode: 'copilot', domains: ['default'] },
        requiresRelaunch: false,
      });
      const coordinator = bindStubCoordinator(cordis, ctx.sessionManager.getSessionId(), {
        domains: ['default'],
        majorMode: 'copilot',
        layers: ['team'],
      });
      return () => coordinator.dispose();
    });
    await configFiber;
    disposeConfig = () => void configFiber.dispose().then(() => connection.dispose());

    // Dismissing the picker returns before any transition, so this exercises
    // exactly the lazy view resolution and nothing after it.
    await handler('', ctx);

    expect(select).toHaveBeenCalledWith('Major mode (current: copilot)', ['[x] copilot: team']);
    homedir.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('rethrows a failed registration rather than loading half an extension', async () => {
    const { pi } = harness();
    const failing = {
      ...pi,
      registerCommand: vi.fn(() => {
        throw new Error('registration boom');
      }),
    } as unknown as ExtensionAPI;

    // The factory disposes its fiber before rethrowing, so Pi sees the failure
    // rather than a session with a voice tool and no command behind it.
    await expect(majorModeExtension(failing, telemetry)).rejects.toThrow('registration boom');
  });
});
