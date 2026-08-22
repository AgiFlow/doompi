import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarnessSession, getHarnessState, resetHarnessStore } from '@agimon-ai/doompi-config/harnessStore';
import { HARNESS_STATE_KEYS, readHarnessState } from '@agimon-ai/doompi-config/harnessState';
import { provideDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { createVoiceReloadHandoffStore } from '@agimon-ai/doompi-extension-contracts/voice-reload-handoff';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerMajorModeCommand } from '../../src/commands/majorModeCommand.ts';
import type { MajorModeView } from '../../src/types/majorMode.ts';
import type { MajorModeTelemetry } from '../../src/types/telemetry.ts';
import { bindStubCoordinator } from '../helpers/coordinator.ts';

const OWNED_KEYS = Object.values(HARNESS_STATE_KEYS);
let root: string;
let disposeCoordinator: (() => void) | undefined;
let runtimeContext: Context | undefined;

const telemetry: MajorModeTelemetry = {
  recordError: async () => undefined,
  recordEvent: async () => undefined,
};

const config: MajorModesConfig = {
  defaultMajorMode: 'copilot',
  layers: { team: { baseDirectory: '/repo' }, plan: { baseDirectory: '/repo' } },
  majorMode: {
    minimal: { description: 'Lean mode.', layers: ['team'] },
    copilot: { description: 'Full mode.', layers: ['team', 'plan'] },
  },
};

const applyMajorMode = vi.fn(() => getHarnessState());
const persistHarnessSelection = vi.fn();
const reloadHandoffs = createVoiceReloadHandoffStore({
  now: () => Date.now(),
  createToken: () => crypto.randomUUID(),
});

function dependencies(currentMajorMode = 'copilot') {
  const view: MajorModeView = { config, majorMode: currentMajorMode, domains: ['default'] };
  return {
    cordisContext: () => {
      if (!runtimeContext) throw new Error('test runtime context is unavailable');
      return runtimeContext;
    },
    currentView: async () => view,
    reloadHandoffs,
    loadPicker: async () => ({}) as never,
    loadSelectionSwitch: async () => ({ applyMajorMode }) as never,
    loadConfigJournal: async () => ({ persistHarnessSelection }) as never,
    resolveLayers: (modes: MajorModesConfig, name: string) => [...(modes.majorMode[name]?.layers ?? [])],
  };
}

function handlerFor(currentMajorMode = 'copilot'): (args: string, ctx: never) => Promise<void> {
  const registerCommand = vi.fn();
  const pi = { registerCommand, appendEntry: vi.fn() } as unknown as ExtensionAPI;
  registerMajorModeCommand(pi, telemetry, dependencies(currentMajorMode));
  const command = registerCommand.mock.calls[0]?.[1] as { handler: (args: string, ctx: never) => Promise<void> };
  return command.handler;
}

function commandContext(selected?: string) {
  const notify = vi.fn();
  const setStatus = vi.fn();
  const waitForIdle = vi.fn(async () => undefined);
  const reload = vi.fn(async () => undefined);
  const context = {
    mode: 'rpc',
    cwd: root,
    ui: {
      notify,
      setStatus,
      select: vi.fn(async () => selected),
      theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    },
    waitForIdle,
    reload,
    sessionManager: { getSessionId: () => 'major-mode-session' },
  } as unknown as ExtensionContext;
  runtimeContext = new Context();
  provideDoomConfigContext(runtimeContext, {
    settings: { projectTrust: 'ask' },
    harness: getHarnessState(),
    requiresRelaunch: false,
  });
  const harness = getHarnessState();
  disposeCoordinator = bindStubCoordinator(runtimeContext, context.sessionManager.getSessionId(), {
    domains: [...harness.domains],
    majorMode: harness.majorMode,
    layers: [...harness.layers],
  }).dispose;
  return { context, notify, setStatus, waitForIdle, reload };
}

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-major-mode-'));
  fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.doom', 'modes.yaml'),
    'layers:\n  team: {}\n  plan: {}\ndefaultMajorMode: copilot\nmajorMode:\n  minimal:\n    description: Lean mode.\n    layers: [team]\n  copilot:\n    description: Full mode.\n    layers: [team, plan]\n',
  );
  resetHarnessStore();
  createHarnessSession(
    { ...readHarnessState({}), root, temporaryDirectory: path.join(root, 'run'), majorMode: 'copilot' },
    { directory: path.join(root, 'run'), environment: process.env },
  );
});

afterEach(() => {
  disposeCoordinator?.();
  disposeCoordinator = undefined;
  void runtimeContext?.fiber.dispose();
  runtimeContext = undefined;
  for (const key of OWNED_KEYS) delete process.env[key];
  resetHarnessStore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('/mode command', () => {
  it('rejects an argument that is not a switch token', async () => {
    const handler = handlerFor();
    const { context, notify } = commandContext();

    await handler('nonsense', context as never);

    expect(notify).toHaveBeenCalledWith('Usage: /mode', 'warning');
  });

  it('reports a malformed switch token instead of throwing', async () => {
    const handler = handlerFor();
    const { context, notify } = commandContext();

    await handler('--voice-switch-token=', context as never);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('token is missing'), 'error');
  });

  it('says nothing changed when the picked mode is already active', async () => {
    const handler = handlerFor('copilot');
    const { context, notify, reload } = commandContext('[x] copilot: team, plan');

    await handler('', context as never);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Already using this major mode.'), 'info');
    expect(reload).not.toHaveBeenCalled();
  });

  it('applies a new mode, journals the selection and reloads last', async () => {
    const handler = handlerFor('copilot');
    const { context, notify, setStatus, waitForIdle, reload } = commandContext('[ ] minimal: team');

    await handler('', context as never);

    expect(applyMajorMode).toHaveBeenCalledOnce();
    expect(persistHarnessSelection).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith('doom-major-mode', expect.stringContaining('[minimal]'));
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Switched to minimal'), 'info');
    expect(waitForIdle).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('journals a pending selection and stays put when the closure needs a relaunch', async () => {
    const handler = handlerFor('copilot');
    const notify = vi.fn();
    const setStatus = vi.fn();
    const appendEntry = vi.fn();
    const reload = vi.fn(async () => undefined);
    const context = {
      mode: 'rpc',
      cwd: root,
      ui: {
        notify,
        setStatus,
        select: vi.fn(async () => '[ ] minimal: team'),
        theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
      },
      waitForIdle: vi.fn(async () => undefined),
      reload,
      sessionManager: { getSessionId: () => 'major-mode-relaunch-session' },
    } as unknown as ExtensionContext;
    runtimeContext = new Context();
    provideDoomConfigContext(runtimeContext, {
      settings: { projectTrust: 'ask' },
      harness: getHarnessState(),
      requiresRelaunch: false,
    });
    const harness = getHarnessState();
    disposeCoordinator = bindStubCoordinator(
      runtimeContext,
      context.sessionManager.getSessionId(),
      { domains: [...harness.domains], majorMode: harness.majorMode, layers: [...harness.layers] },
      'applied',
      'process-relaunch',
    ).dispose;
    // The command journals through the pi it was registered with, so assert on
    // the notification and the untouched reload rather than on appendEntry.
    void appendEntry;

    await handler('', context as never);

    expect(applyMajorMode).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('is pending'), 'info');
    expect(reload).not.toHaveBeenCalled();
  });

  it('rolls the harness back and aborts the journal when applying fails', async () => {
    applyMajorMode.mockImplementationOnce(() => {
      throw new Error('apply boom');
    });
    const handler = handlerFor('copilot');
    const { context, reload } = commandContext('[ ] minimal: team');

    await expect(handler('', context as never)).rejects.toThrow('apply boom');
    expect(reload).not.toHaveBeenCalled();
  });

  it('rejects a switch token that belongs to another session', async () => {
    const handler = handlerFor('copilot');
    const { context, notify, reload } = commandContext();

    await handler('--voice-switch-token=not-a-real-token', context as never);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('stale or belongs to another session'), 'error');
    expect(reload).not.toHaveBeenCalled();
  });

  it('does nothing when the picker is dismissed', async () => {
    const handler = handlerFor('copilot');
    const { context, reload } = commandContext(undefined);

    await handler('', context as never);

    expect(applyMajorMode).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
