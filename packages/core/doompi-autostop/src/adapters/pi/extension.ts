import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { type AutoStopDelays, DEFAULT_AUTO_STOP_DELAYS } from '../../services/idlePolicy.ts';
import { registerIdleShutdown } from './idleShutdown.ts';

const PACKAGE_SOURCE = '@agimon-ai/doompi-autostop';

/**
 * The package's single standard Pi factory.
 */
export async function autoStopExtension(
  pi: ExtensionAPI,
  delays: AutoStopDelays = DEFAULT_AUTO_STOP_DELAYS,
): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(autoStopPlugin, { pi, delays });
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

interface AutoStopPluginConfig {
  readonly pi: ExtensionAPI;
  readonly delays: AutoStopDelays;
}

function autoStopPlugin(cordis: Context, config: AutoStopPluginConfig): void {
  cordis.effect(function* () {
    yield registerIdleShutdown(config.pi, config.delays);
  }, PACKAGE_SOURCE);
}

export default autoStopExtension;
