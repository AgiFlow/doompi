// @scaffold-generated
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSandboxCommand } from '../../commands/doomSandboxCommand.ts';
import { createSandboxContainer } from '../../container';
import type { SandboxExtensionDependencies } from '../../types/extension';

const PACKAGE_SOURCE = '@agimon-ai/doompi-sandbox';

/**
 * Installs the package runtime inside its host-owned Cordis plugin fiber.
 *
 * Everything registered inside the effect is owned by the cordis fiber, so one
 * dispose on session shutdown unwinds it in reverse order. Yield a disposer for
 * each registration rather than tracking cleanup by hand; Pi can reload an
 * extension in-process, and a leaked listener duplicates work against stale
 * session state.
 */
export function installSandboxRuntime(
  cordis: Context,
  pi: ExtensionAPI,
  dependencies: SandboxExtensionDependencies = createSandboxContainer(),
): void {
  cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
    const contribution = requireDoomHelpService(helpContext).register({
      source: PACKAGE_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-use-sandbox',
          description:
            'Use @agimon-ai/doompi-sandbox: Container sandbox for DoomPi launches: the agent, extensions, and tools run inside Docker or Podman while the terminal stays on the host',
        },
      ],
    });
    return () => contribution.dispose();
  });

  registerSandboxCommand(pi, dependencies.service);
}

interface SandboxPluginConfig {
  readonly pi: ExtensionAPI;
  readonly dependencies: SandboxExtensionDependencies;
}

function sandboxPlugin(cordis: Context, config: SandboxPluginConfig): void {
  installSandboxRuntime(cordis, config.pi, config.dependencies);
}

/** Connects the package's standard Pi entry to DoomPi's shared Cordis host. */
export async function activateSandboxExtension(
  pi: ExtensionAPI,
  dependencies: SandboxExtensionDependencies = createSandboxContainer(),
): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(sandboxPlugin, { pi, dependencies });

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

export default activateSandboxExtension;
