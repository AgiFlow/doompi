import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerAuthorCommand } from '../../commands/doomAuthorCommand.ts';
import { registerAuthorToolFacades } from './authorTools.ts';
import { createAuthorContainer } from '../../container/index.ts';
import { installAuthorMode } from '../../services/authorMode.ts';
import type { AuthorExtensionDependencies } from '../../types/extension.ts';

const PACKAGE_SOURCE = '@agimon-ai/doompi-author';

/**
 * Installs the package runtime inside its host-owned Cordis plugin fiber.
 *
 * Everything registered inside the effect is owned by the cordis fiber, so one
 * dispose on session shutdown unwinds it in reverse order. Yield a disposer for
 * each registration rather than tracking cleanup by hand; Pi can reload an
 * extension in-process, and a leaked listener duplicates work against stale
 * session state.
 */
export function installAuthorRuntime(
  cordis: Context,
  pi: ExtensionAPI,
  dependencies: AuthorExtensionDependencies = createAuthorContainer(),
): void {
  cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
    const contribution = requireDoomHelpService(helpContext).register({
      source: PACKAGE_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-use-author',
          description:
            'Use @agimon-ai/doompi-author: Visual steering workspace for focused document review and bounded authoring',
        },
      ],
    });
    return () => contribution.dispose();
  });

  installAuthorMode(cordis, pi, dependencies.catalog, registerAuthorToolFacades);
  registerAuthorCommand(pi, dependencies.service);
}

interface AuthorPluginConfig {
  readonly pi: ExtensionAPI;
  readonly dependencies: AuthorExtensionDependencies;
}

function authorPlugin(cordis: Context, config: AuthorPluginConfig): void {
  installAuthorRuntime(cordis, config.pi, config.dependencies);
}

/** Connects the package's standard Pi entry to DoomPi's shared Cordis host. */
export async function activateAuthorExtension(
  pi: ExtensionAPI,
  dependencies: Partial<AuthorExtensionDependencies> = {},
): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(authorPlugin, { pi, dependencies: createAuthorContainer(dependencies) });

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

export default activateAuthorExtension;
