// @scaffold-generated
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerGitCommand } from '../../commands/doomGitCommand.ts';
import { registerRunWorktreeTool } from './extensions/runWorktreeTool.ts';
import { createGitContainer } from '../../container';
import type { GitExtensionDependencies } from '../../types/extension';

const PACKAGE_SOURCE = '@agimon-ai/doompi-git';

/**
 * Installs the package runtime inside its host-owned Cordis plugin fiber.
 *
 * Everything registered inside the effect is owned by the cordis fiber, so one
 * dispose on session shutdown unwinds it in reverse order. Yield a disposer for
 * each registration rather than tracking cleanup by hand; Pi can reload an
 * extension in-process, and a leaked listener duplicates work against stale
 * session state.
 */
export function installGitRuntime(
  cordis: Context,
  pi: ExtensionAPI,
  dependencies: GitExtensionDependencies = createGitContainer(),
): void {
  cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
    const contribution = requireDoomHelpService(helpContext).register({
      source: PACKAGE_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-use-git',
          description:
            'Use @agimon-ai/doompi-git: Git worktree sessions for DoomPi: spawn an isolated worktree with its own session and manage it from the parent',
        },
      ],
    });
    return () => contribution.dispose();
  });

  registerGitCommand(pi, dependencies.service);
  registerRunWorktreeTool(pi, dependencies.operations);
}

interface GitPluginConfig {
  readonly pi: ExtensionAPI;
  readonly dependencies: GitExtensionDependencies;
}

function gitPlugin(cordis: Context, config: GitPluginConfig): void {
  installGitRuntime(cordis, config.pi, config.dependencies);
}

/** Connects the package's standard Pi entry to DoomPi's shared Cordis host. */
export async function activateGitExtension(
  pi: ExtensionAPI,
  // Partial so a caller, and every test, can stand in one collaborator without
  // having to construct the rest of the graph it does not care about.
  overrides: Partial<GitExtensionDependencies> = {},
): Promise<void> {
  const dependencies = createGitContainer(overrides);
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(gitPlugin, { pi, dependencies });

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

export default activateGitExtension;
