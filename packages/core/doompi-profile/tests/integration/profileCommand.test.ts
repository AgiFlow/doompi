import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { provideDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import { createHarnessSession, getHarnessState, resetHarnessStore } from '@agimon-ai/doompi-config/harnessStore';
import type { HarnessState } from '@agimon-ai/doompi-config/types';
import { HARNESS_STATE_KEYS, readHarnessState } from '@agimon-ai/doompi-config/harnessState';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProfileCommand } from '../../src/commands/profileCommand.ts';
import type { ProfileTelemetry } from '../../src/types/telemetry.ts';
import { bindStubCoordinator } from '../helpers/coordinator.ts';

const OWNED_KEYS = Object.values(HARNESS_STATE_KEYS);
let root: string;
let disposeCoordinator: (() => void) | undefined;
let runtimeContext: Context | undefined;

const telemetry: ProfileTelemetry = {
  recordError: async () => undefined,
  recordEvent: async () => undefined,
};

function registerProfileHandler(): (args: string, context: never) => Promise<void> {
  const registerCommand = vi.fn();
  registerProfileCommand({ registerCommand, appendEntry: vi.fn() } as unknown as ExtensionAPI, telemetry, () => {
    if (!runtimeContext) throw new Error('test runtime context is unavailable');
    return runtimeContext;
  });
  const command = registerCommand.mock.calls[0]?.[1] as {
    handler: (args: string, context: never) => Promise<void>;
  };
  return command.handler;
}

function commandContext(selected?: string) {
  const notify = vi.fn();
  const select = vi.fn(async () => selected);
  const waitForIdle = vi.fn(async () => undefined);
  const reload = vi.fn(async () => undefined);
  const context = {
    mode: 'rpc',
    ui: { notify, select },
    waitForIdle,
    reload,
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => 'profile-entry-session',
    } as unknown as ExtensionContext['sessionManager'],
  };
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
    profile: harness.profile,
  }).dispose;
  return { context, notify, waitForIdle, reload };
}

/**
 * Opens a session the way the launcher does.
 *
 * Through the store rather than the environment: profileEnvironment is one of
 * the fields only the state file carries.
 */
function seedHarnessState(patch: Partial<HarnessState>): void {
  const temporaryDirectory = patch.temporaryDirectory ?? path.join(root, 'run');
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  resetHarnessStore();
  createHarnessSession(
    { ...readHarnessState({}), root, temporaryDirectory, ...patch },
    { directory: temporaryDirectory, environment: process.env },
  );
}

function writeProfileConfig(): void {
  const personaDirectory = path.join(root, 'agents', 'agiflow', 'mara-voss');
  fs.mkdirSync(personaDirectory, { recursive: true });
  fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
  fs.writeFileSync(path.join(personaDirectory, 'profile.md'), '# Mara');
  fs.writeFileSync(
    path.join(root, '.doom', 'profiles.yaml'),
    'profiles:\n  roots: [agents/agiflow]\n  entries:\n    marketing-agiflow:\n      persona: agents/agiflow/mara-voss\n      env:\n        BRAND: agiflow\n',
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-profile-'));
});

afterEach(() => {
  disposeCoordinator?.();
  disposeCoordinator = undefined;
  void runtimeContext?.fiber.dispose();
  runtimeContext = undefined;
  for (const key of OWNED_KEYS) delete process.env[key];
  delete process.env.BRAND;
  resetHarnessStore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('profile command', () => {
  it('reports when no profile config exists', async () => {
    seedHarnessState({ profileEnvironment: {} });
    const handler = registerProfileHandler();
    const { context, notify } = commandContext();

    await handler('', context as never);

    expect(notify).toHaveBeenCalledWith('No profiles found in .doom/profiles.yaml.', 'warning');
  });

  it('reports an invalid profile config', async () => {
    seedHarnessState({ profileEnvironment: {} });
    fs.mkdirSync(path.join(root, '.doom'), { recursive: true });
    fs.writeFileSync(path.join(root, '.doom', 'profiles.yaml'), 'profiles: []\n');
    const handler = registerProfileHandler();
    const { context, notify } = commandContext();

    await handler('', context as never);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Could not load .doom/profiles.yaml'), 'warning');
  });

  it('summarizes the profile that is already active', async () => {
    writeProfileConfig();
    seedHarnessState({ profile: 'marketing-agiflow', profileEnvironment: {} });
    const handler = registerProfileHandler();
    const { context, notify, waitForIdle, reload } = commandContext('marketing-agiflow');

    await handler('', context as never);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Already loaded.'), 'info');
    expect(waitForIdle).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('loads a newly selected profile and reloads as its final action', async () => {
    writeProfileConfig();
    seedHarnessState({ profileEnvironment: {} });
    const handler = registerProfileHandler();
    const { context, notify, waitForIdle, reload } = commandContext('marketing-agiflow');

    await handler('', context as never);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Loaded marketing-agiflow'), 'info');
    expect(waitForIdle).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('drives the TUI picker when the session has one', async () => {
    writeProfileConfig();
    seedHarnessState({ profileEnvironment: {} });
    const handler = registerProfileHandler();
    const notify = vi.fn();
    const waitForIdle = vi.fn(async () => undefined);
    const reload = vi.fn(async () => undefined);
    // ui.custom hands the component factory a theme and keybindings and resolves
    // with whatever the component passes to done().
    const custom = vi.fn(async (factory: (...args: never[]) => unknown) => {
      factory(
        {} as never,
        { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as never,
        { matches: () => false } as never,
        (() => undefined) as never,
      );
      return ['marketing-agiflow'];
    });
    const context = {
      mode: 'tui',
      ui: { notify, custom },
      waitForIdle,
      reload,
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => 'profile-tui-session',
      } as unknown as ExtensionContext['sessionManager'],
    };
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

    await handler('', context as never);

    expect(custom).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it('discards the reload handoff when the reload itself fails', async () => {
    writeProfileConfig();
    seedHarnessState({ profileEnvironment: {} });
    const handler = registerProfileHandler();
    const { context, reload } = commandContext('marketing-agiflow');
    reload.mockRejectedValueOnce(new Error('reload boom'));

    await expect(handler('', context as never)).rejects.toThrow('reload boom');
  });

  it('does not reload when the coordinator rejects the transition', async () => {
    writeProfileConfig();
    seedHarnessState({ profileEnvironment: {} });
    const handler = registerProfileHandler();
    const notify = vi.fn();
    const waitForIdle = vi.fn(async () => undefined);
    const reload = vi.fn(async () => undefined);
    const context = {
      mode: 'rpc',
      ui: { notify, select: vi.fn(async () => 'marketing-agiflow') },
      waitForIdle,
      reload,
      sessionManager: {
        getBranch: () => [],
        getSessionId: () => 'profile-rejected-session',
      } as unknown as ExtensionContext['sessionManager'],
    };
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
      'rejected',
    ).dispose;

    await handler('', context as never);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Profile transition was rejected'), 'warning');
    expect(reload).not.toHaveBeenCalled();
  });
});
