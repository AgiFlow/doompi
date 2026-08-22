import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import {
  DOOM_TOOL_OVERRIDES_SERVICE,
  requireDoomToolOverrides,
} from '@agimon-ai/doompi-extension-contracts/tool-overrides';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerHashlineReadTool } from './readTool.ts';

const PACKAGE_SOURCE = '@agimon-ai/doompi-read';

/** Install the hashline read tool after claiming Pi's shared read name. */
export function installDoomPiReadRuntime(cordis: Context, pi: ExtensionAPI): void {
  cordis.inject([DOOM_TOOL_OVERRIDES_SERVICE], (overridesContext) => {
    const registration = requireDoomToolOverrides(overridesContext).claim({
      source: PACKAGE_SOURCE,
      tools: ['read'],
    });
    if (!registration.granted) return;
    try {
      registerHashlineReadTool(pi);
    } catch (error) {
      registration.dispose();
      throw error;
    }
    return () => registration.dispose();
  });
}

/** Connect the package's standard Pi entry to DoomPi's shared Cordis host. */
export async function activateDoomPiReadExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(doomPiReadPlugin, { pi });
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

interface DoomPiReadPluginConfig {
  readonly pi: ExtensionAPI;
}

function doomPiReadPlugin(cordis: Context, config: DoomPiReadPluginConfig): void {
  installDoomPiReadRuntime(cordis, config.pi);
}

export default activateDoomPiReadExtension;
