import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import { DOOM_UI_HUB_SERVICE, requireDoomUiHub } from '@agimon-ai/doompi-extension-contracts/ui-hub';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerPromptSaveCommand } from '../../commands/promptSaveCommand.ts';
import { registerPromptsCommand } from '../../commands/promptsCommand.ts';
import { createPromptContainer } from '../../container';
import type { PromptExtensionDependencies } from '../../types/prompt.ts';
import { registerInputCapture } from './inputCapture.ts';
import { registerLeaderContribution } from './leader.ts';
import { PACKAGE_SOURCE } from './promptConstants.ts';

/**
 * Installs the package runtime inside its host-owned Cordis plugin fiber.
 *
 * Everything registered inside the effect is owned by the cordis fiber, so one
 * dispose on session shutdown unwinds it in reverse order. Yield a disposer for
 * each registration rather than tracking cleanup by hand; Pi can reload an
 * extension in-process, and a leaked listener duplicates work against stale
 * session state.
 */
export function installPromptRuntime(
  cordis: Context,
  pi: ExtensionAPI,
  dependencies: PromptExtensionDependencies = createPromptContainer(),
): void {
  cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
    const contribution = requireDoomHelpService(helpContext).register({
      source: PACKAGE_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-use-prompt',
          description: 'Use @agimon-ai/doompi-prompt: Staged recent prompts and saved prompt templates for DoomPi',
        },
      ],
    });
    return () => contribution.dispose();
  });

  cordis.inject([DOOM_UI_HUB_SERVICE], (uiContext) => registerLeaderContribution(requireDoomUiHub(uiContext)));

  // Staging is fed by the host's input event rather than the editor, so pi-tui's
  // own arrow up/down history keeps working exactly as it does without this package.
  registerInputCapture(pi, dependencies.recent);

  registerPromptsCommand(pi, dependencies);
  registerPromptSaveCommand(pi, dependencies);
}

interface PromptPluginConfig {
  readonly pi: ExtensionAPI;
  readonly dependencies: PromptExtensionDependencies;
}

function promptPlugin(cordis: Context, config: PromptPluginConfig): void {
  installPromptRuntime(cordis, config.pi, config.dependencies);
}

/** Connects the package's standard Pi entry to DoomPi's shared Cordis host. */
export async function activatePromptExtension(
  pi: ExtensionAPI,
  dependencies: PromptExtensionDependencies = createPromptContainer(),
): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(promptPlugin, { pi, dependencies });

  try {
    await fiber;
  } catch (error) {
    try {
      await fiber.dispose();
    } finally {
      await connection.dispose();
    }
    throw error;
  }

  let disposal: Promise<void> | undefined;
  pi.on(
    'session_shutdown',
    () =>
      (disposal ??= (async () => {
        try {
          await fiber.dispose();
        } finally {
          await connection.dispose();
        }
      })()),
  );
}

export default activatePromptExtension;
