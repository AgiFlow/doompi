import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readHarnessState } from '@agimon-ai/doompi-config/harnessState';
import { provideDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { createDoomHelpService, DOOM_HELP_SERVICE } from '@agimon-ai/doompi-extension-contracts/help';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { profileExtension } from '../../src/adapters/pi/extension.ts';
import type { ProfileTelemetry } from '../../src/types/telemetry.ts';
import { bindStubCoordinator } from '../helpers/coordinator.ts';

const telemetry: ProfileTelemetry = {
  recordError: async () => undefined,
  recordEvent: async () => undefined,
};

function harness(registerCommand = vi.fn()) {
  const handlers = new Map<string, () => Promise<void> | void>();
  const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
  const pi = {
    registerCommand,
    events: {
      emit(event: string, value: unknown) {
        for (const handler of eventHandlers.get(event) ?? []) handler(value);
      },
      on(event: string, handler: (value: unknown) => void) {
        const subscriptions = eventHandlers.get(event) ?? new Set();
        subscriptions.add(handler);
        eventHandlers.set(event, subscriptions);
        return () => subscriptions.delete(handler);
      },
    },
    on(event: string, handler: () => Promise<void> | void) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, registerCommand };
}

async function bindRuntime(
  pi: ExtensionAPI,
  source: string,
  root: string,
): Promise<{ readonly cordis: Context; dispose(): Promise<void> }> {
  const connection = await connectDoomCordisHost(pi, source);
  const fiber = connection.root.plugin((cordis) => {
    provideDoomConfigContext(
      cordis,
      {
        settings: { projectTrust: 'ask' },
        harness: { ...readHarnessState({}), root, domains: ['default'], majorMode: 'copilot' },
        requiresRelaunch: false,
      },
      `${source}:config`,
    );
    const coordinator = bindStubCoordinator(cordis, `${source}:session`, {
      domains: ['default'],
      majorMode: 'copilot',
      layers: [],
    });
    return () => coordinator.dispose();
  });
  await fiber;
  return {
    cordis: connection.root,
    async dispose() {
      try {
        await fiber.dispose();
      } finally {
        await connection.dispose();
      }
    },
  };
}

describe('profile Pi factory', () => {
  it('registers the command and disposes its fiber once on shutdown', async () => {
    const { pi, handlers, registerCommand } = harness();

    await profileExtension(pi, telemetry);

    expect(registerCommand).toHaveBeenCalledWith(
      'profile',
      expect.objectContaining({ description: expect.any(String) }),
    );
    const shutdown = handlers.get('session_shutdown');
    expect(shutdown).toBeTypeOf('function');
    // Idempotent: Pi can fire session_shutdown more than once across a reload.
    await shutdown?.();
    await shutdown?.();
  });

  it('disposes the fiber when registration throws', async () => {
    const { pi } = harness(
      vi.fn(() => {
        throw new Error('registration boom');
      }),
    );

    await expect(profileExtension(pi, telemetry)).rejects.toThrow('registration boom');
  });

  it('registers package Help for each provider generation and withdraws it on disposal', async () => {
    const { pi, handlers } = harness();
    await profileExtension(pi, telemetry);
    const connection = await connectDoomCordisHost(pi, 'profile-help-lifecycle-test');
    const firstService = createDoomHelpService('profile-help-first');
    const firstFiber = connection.root.plugin((context) => context.provide(DOOM_HELP_SERVICE, firstService));
    await firstFiber;

    expect(firstService.listContributions()).toEqual([
      {
        source: '@agimon-ai/doompi-profile',
        moduleUrl: expect.stringMatching(/extension\.ts$/u),
        skills: [
          {
            name: 'doompi-author-profile',
            description:
              'Configure DoomPi profile discovery, personas, environment defaults, and precedence in profiles.yaml. Use when creating or changing personal or repository profiles. Do not use for config.yaml runtime settings, modes.yaml, or domains.yaml.',
          },
        ],
      },
    ]);

    await firstFiber.dispose();
    expect(firstService.listContributions()).toEqual([]);

    const replacementService = createDoomHelpService('profile-help-replacement');
    const replacementFiber = connection.root.plugin((context) =>
      context.provide(DOOM_HELP_SERVICE, replacementService),
    );
    await replacementFiber;
    expect(replacementService.listContributions()).toHaveLength(1);

    await handlers.get('session_shutdown')?.();
    expect(replacementService.listContributions()).toEqual([]);
    await replacementFiber.dispose();
    await connection.dispose();
    firstService.dispose();
    replacementService.dispose();
  });

  it('clears a lost runtime provider and uses its replacement', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-profile-extension-'));
    const { pi, handlers, registerCommand } = harness();
    await profileExtension(pi, telemetry);
    const command = registerCommand.mock.calls[0]?.[1] as
      | { handler: (args: string, context: unknown) => Promise<void> }
      | undefined;
    if (!command) throw new Error('the profile command was not registered');
    const notify = vi.fn();
    const context = {
      mode: 'rpc',
      ui: { notify, select: vi.fn(async () => undefined) },
      sessionManager: { getSessionId: () => 'profile-provider-session' },
    };

    await expect(command.handler('', context)).rejects.toThrow('waiting for the session config service');
    const first = await bindRuntime(pi, 'profile-provider-first', root);
    await command.handler('', context);
    expect(notify).toHaveBeenLastCalledWith('No profiles found in .doom/profiles.yaml.', 'warning');

    await first.dispose();
    await expect(command.handler('', context)).rejects.toThrow('waiting for the session config service');

    const replacement = await bindRuntime(pi, 'profile-provider-replacement', root);
    try {
      await command.handler('', context);
      expect(notify).toHaveBeenCalledTimes(2);
    } finally {
      await replacement.dispose();
      await handlers.get('session_shutdown')?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
