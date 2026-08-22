import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installTeamRuntime } from './extension';

const PACKAGE_SOURCE = '@agimon-ai/doompi-team';

interface TeamPluginConfig {
  readonly pi: ExtensionAPI;
}

/** Mount Team's explicit object graph inside its host-owned Cordis fiber. */
export function teamPlugin(cordis: Context, { pi }: TeamPluginConfig): void {
  installTeamRuntime(cordis, pi);
}

/** The package's single standard Pi factory. */
export async function activateTeamExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(teamPlugin, { pi });
  try {
    await fiber;
  } catch (error) {
    await fiber.dispose();
    await connection.dispose();
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

export default activateTeamExtension;
