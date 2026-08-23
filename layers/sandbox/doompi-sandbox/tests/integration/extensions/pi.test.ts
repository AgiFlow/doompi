// @scaffold-generated
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { createDoomHelpService, DOOM_HELP_SERVICE } from '@agimon-ai/doompi-extension-contracts/help';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { COMMAND_NAME } from '../../../src/commands/doomSandboxCommand.ts';
import { activateSandboxExtension } from '../../../src/adapters/pi/extension.ts';
import type { SandboxExtensionService } from '../../../src/types/extension.ts';

interface CommandDefinition {
  handler: (
    args: string,
    ctx: { hasUI: boolean; ui: { notify: (message: string, level: string) => void } },
  ) => Promise<void>;
}

function createPiFixture(): {
  commands: Map<string, CommandDefinition>;
  listeners: Map<string, () => void | Promise<void>>;
  pi: ExtensionAPI;
} {
  const commands = new Map<string, CommandDefinition>();
  const listeners = new Map<string, () => void | Promise<void>>();
  const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const pi = {
    events: {
      emit(event: string, payload: unknown) {
        for (const handler of eventHandlers.get(event) ?? []) handler(payload);
      },
      on(event: string, handler: (payload: unknown) => void) {
        const handlers = eventHandlers.get(event) ?? new Set();
        handlers.add(handler);
        eventHandlers.set(event, handlers);
        return () => handlers.delete(handler);
      },
    },
    on: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    registerCommand: vi.fn((name: string, definition: CommandDefinition) => commands.set(name, definition)),
  } as unknown as ExtensionAPI;
  return { commands, listeners, pi };
}

describe('doompi-sandbox Pi extension', () => {
  it('injects its service into the standalone command', async () => {
    const fixture = createPiFixture();
    const service: SandboxExtensionService = {
      execute: vi.fn().mockResolvedValue({ message: 'ready', level: 'info' }),
    };
    const notify = vi.fn();

    await activateSandboxExtension(fixture.pi, { service });
    await fixture.commands.get(COMMAND_NAME)?.handler('', { hasUI: true, ui: { notify } });

    expect(service.execute).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith('ready', 'info');
  });

  it('is headless-safe', async () => {
    const fixture = createPiFixture();
    const service: SandboxExtensionService = {
      execute: vi.fn().mockResolvedValue({ message: 'ready', level: 'info' }),
    };
    const notify = vi.fn();

    await activateSandboxExtension(fixture.pi, { service });
    await fixture.commands.get(COMMAND_NAME)?.handler('', { hasUI: false, ui: { notify } });

    expect(notify).not.toHaveBeenCalled();
  });

  it('installs once per host and permits the next Pi runtime after shutdown', async () => {
    const fixture = createPiFixture();

    await activateSandboxExtension(fixture.pi);
    await fixture.listeners.get('session_shutdown')?.();
    await fixture.listeners.get('session_shutdown')?.();
    await activateSandboxExtension(fixture.pi);

    expect(fixture.pi.registerCommand).toHaveBeenCalledTimes(2);
  });

  it('follows optional Help provider replacement and withdraws its contribution on shutdown', async () => {
    const fixture = createPiFixture();
    await activateSandboxExtension(fixture.pi);
    const connection = await connectDoomCordisHost(fixture.pi, 'doompi-sandbox-help-test');
    const firstService = createDoomHelpService('doompi-sandbox-help-first');
    const firstFiber = connection.root.plugin((context) => context.provide(DOOM_HELP_SERVICE, firstService));
    await firstFiber;

    expect(firstService.listContributions()).toEqual([
      {
        source: '@agimon-ai/doompi-sandbox',
        moduleUrl: expect.stringMatching(/extension\.ts$/u),
        skills: [
          {
            name: 'doompi-use-sandbox',
            description:
              'Use @agimon-ai/doompi-sandbox: Container sandbox for DoomPi launches: the agent, extensions, and tools run inside Docker or Podman while the terminal stays on the host',
          },
        ],
      },
    ]);

    await firstFiber.dispose();
    expect(firstService.listContributions()).toEqual([]);

    const replacementService = createDoomHelpService('doompi-sandbox-help-replacement');
    const replacementFiber = connection.root.plugin((context) =>
      context.provide(DOOM_HELP_SERVICE, replacementService),
    );
    await replacementFiber;
    expect(replacementService.listContributions()).toHaveLength(1);

    await fixture.listeners.get('session_shutdown')?.();
    await fixture.listeners.get('session_shutdown')?.();
    expect(replacementService.listContributions()).toEqual([]);

    await replacementFiber.dispose();
    await connection.dispose();
  });
});
