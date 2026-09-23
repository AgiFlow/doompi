import { connectDoomCordisHost } from '@agimon-ai/doompi-core/cordisHost';
import { createDoomHelpService, DOOM_HELP_SERVICE } from '@agimon-ai/doompi-core/help';
import { createPiTestHost, standardExtensionScenarios } from '@agimon-ai/doompi-core/testing';
import { describe, expect, it, vi } from 'vitest';

import { extension as activateAuthorExtension } from '../../../generated/pi';
import { AUTHOR_COMMAND_NAME as COMMAND_NAME } from '../../../src/constants/author';
import type { AuthorExtensionService } from '../../../src/types/extension';

/**
 * The Pi surface.
 *
 * The lifecycle every standard entry owes its host comes from the shared
 * contract, so this package proves the same things every other extension does
 * rather than its own subset. Whatever is particular to this package goes
 * below it.
 */
describe('the standard Pi entry contract', () => {
  for (const scenario of standardExtensionScenarios({
    factory: activateAuthorExtension,
    commands: [COMMAND_NAME],
  })) {
    it(scenario.name, () => scenario.run());
  }
});

describe('doompi-author Pi extension', () => {
  it('injects its service into the standalone command', async () => {
    const host = createPiTestHost();
    const service: AuthorExtensionService = {
      execute: vi.fn().mockResolvedValue({ message: 'ready', level: 'info' }),
    };

    await host.cordis();
    await activateAuthorExtension(host.pi, { service });
    await host.runCommand(COMMAND_NAME);

    expect(service.execute).toHaveBeenCalledOnce();
    expect(host.notifications).toEqual([{ sessionId: 'test-session', message: 'ready', level: 'info' }]);
    await host.dispose();
  });

  it('says nothing where there is no UI to say it in', async () => {
    // The cockpit and the RPC runtime both load extensions with no terminal.
    const host = createPiTestHost({ hasUI: false, mode: 'rpc' });
    const service: AuthorExtensionService = {
      execute: vi.fn().mockResolvedValue({ message: 'ready', level: 'info' }),
    };

    await host.cordis();
    await activateAuthorExtension(host.pi, { service });
    await host.runCommand(COMMAND_NAME);

    expect(host.notifications).toEqual([]);
    await host.dispose();
  });

  it('follows optional Help provider replacement and withdraws its contribution on shutdown', async () => {
    const host = createPiTestHost();
    await host.cordis();
    await activateAuthorExtension(host.pi);
    const connection = await connectDoomCordisHost(host.pi, 'doompi-author-help-test');
    const firstService = createDoomHelpService('doompi-author-help-first');
    const firstFiber = connection.root.plugin((context) => context.provide(DOOM_HELP_SERVICE, firstService));
    await firstFiber;

    expect(firstService.listContributions()).toEqual([
      {
        source: '@agimon-ai/doompi-author',
        moduleUrl: expect.stringMatching(/extensions\/workspaces\/sessions\/\(backend\)\/root\.cli\.ts$/u),
        skills: [
          {
            name: 'doompi-use-author',
            description:
              'Use @agimon-ai/doompi-author: Visual steering workspace for focused document review and bounded authoring',
          },
        ],
      },
    ]);

    await firstFiber.dispose();
    expect(firstService.listContributions()).toEqual([]);

    const replacementService = createDoomHelpService('doompi-author-help-replacement');
    const replacementFiber = connection.root.plugin((context) =>
      context.provide(DOOM_HELP_SERVICE, replacementService),
    );
    await replacementFiber;
    expect(replacementService.listContributions()).toHaveLength(1);

    await host.emit('session_shutdown', { reason: 'quit' });
    await host.emit('session_shutdown', { reason: 'quit' });
    expect(replacementService.listContributions()).toEqual([]);

    await replacementFiber.dispose();
    firstService.dispose();
    replacementService.dispose();
    await connection.dispose();
    await host.dispose();
  });
});
