import { createPiTestHost, standardExtensionScenarios } from '@agimon-ai/doompi-extension-contracts/testing';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { createDoomHelpService, DOOM_HELP_SERVICE } from '@agimon-ai/doompi-extension-contracts/help';
import { describe, expect, it } from 'vitest';
import { COMMAND_NAME as PROMPT_SAVE_COMMAND } from '../../../src/commands/promptSaveCommand.ts';
import { COMMAND_NAME } from '../../../src/commands/promptsCommand.ts';
import { createRecentPrompts } from '../../../src/services/recentPrompts.ts';
import { activatePromptExtension } from '../../../src/adapters/pi/extension.ts';
import type { PromptExtensionDependencies, SavedPrompt } from '../../../src/types/prompt.ts';

/** A store that never touches the developer's own prompts directory. */
function memoryDependencies(): PromptExtensionDependencies {
  const saved: SavedPrompt[] = [];
  return {
    recent: createRecentPrompts(),
    store: {
      list: async () => saved,
      has: async (name) => saved.some((prompt) => prompt.name === name),
      save: async (prompt) => {
        saved.push(prompt);
        return { name: prompt.name, path: `/memory/${prompt.name}.md` };
      },
      remove: async (name) => {
        const index = saved.findIndex((prompt) => prompt.name === name);
        if (index === -1) return false;
        saved.splice(index, 1);
        return true;
      },
    },
  };
}

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
    factory: (pi) => activatePromptExtension(pi, memoryDependencies()),
    commands: [COMMAND_NAME, PROMPT_SAVE_COMMAND],
  })) {
    it(scenario.name, () => scenario.run());
  }
});

describe('doompi-prompt Pi extension', () => {
  it('stages a prompt the user submitted earlier in the session', async () => {
    // The picker itself is exercised in tests/integration/commands: the shared
    // host never resolves a custom component, so opening it here would hang.
    const host = createPiTestHost();
    const dependencies = memoryDependencies();

    await activatePromptExtension(host.pi, dependencies);
    await host.emit('input', { text: 'review the diff', source: 'interactive' });

    expect(dependencies.recent.list()).toEqual(['review the diff']);
    await host.dispose();
  });

  it('ignores input an extension injected', async () => {
    const host = createPiTestHost();
    const dependencies = memoryDependencies();

    await activatePromptExtension(host.pi, dependencies);
    await host.emit('input', { text: 'injected', source: 'extension' });

    expect(dependencies.recent.list()).toEqual([]);
    await host.dispose();
  });

  it('says nothing where there is no UI to say it in', async () => {
    // The cockpit and the RPC runtime both load extensions with no terminal.
    const host = createPiTestHost({ hasUI: false, mode: 'rpc' });

    await activatePromptExtension(host.pi, memoryDependencies());
    await host.runCommand(COMMAND_NAME);

    expect(host.notifications).toEqual([]);
    await host.dispose();
  });

  it('follows optional Help provider replacement and withdraws its contribution on shutdown', async () => {
    const host = createPiTestHost();
    await activatePromptExtension(host.pi, memoryDependencies());
    const connection = await connectDoomCordisHost(host.pi, 'doompi-prompt-help-test');
    const firstService = createDoomHelpService('doompi-prompt-help-first');
    const firstFiber = connection.root.plugin((context) => context.provide(DOOM_HELP_SERVICE, firstService));
    await firstFiber;

    expect(firstService.listContributions()).toEqual([
      {
        source: '@agimon-ai/doompi-prompt',
        moduleUrl: expect.stringMatching(/extension\.ts$/u),
        skills: [
          {
            name: 'doompi-use-prompt',
            description: 'Use @agimon-ai/doompi-prompt: Staged recent prompts and saved prompt templates for DoomPi',
          },
        ],
      },
    ]);

    await firstFiber.dispose();
    expect(firstService.listContributions()).toEqual([]);

    const replacementService = createDoomHelpService('doompi-prompt-help-replacement');
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
