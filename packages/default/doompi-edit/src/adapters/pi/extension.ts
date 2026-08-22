import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import {
  DOOM_TOOL_OVERRIDES_SERVICE,
  requireDoomToolOverrides,
} from '@agimon-ai/doompi-extension-contracts/tool-overrides';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerHashlineEditTool } from './editTool.ts';

const PACKAGE_SOURCE = '@agimon-ai/doompi-edit';

/** Install the hashline edit tool after claiming its shared Pi name. */
export function installDoomPiEditRuntime(cordis: Context, pi: ExtensionAPI): void {
  cordis.inject([DOOM_TOOL_OVERRIDES_SERVICE], (overridesContext) => {
    const registration = requireDoomToolOverrides(overridesContext).claim({
      source: PACKAGE_SOURCE,
      tools: ['edit'],
    });
    if (!registration.granted) return;
    try {
      registerHashlineEditTool(pi);
    } catch (error) {
      registration.dispose();
      throw error;
    }
    return () => registration.dispose();
  });
}

/** Connect the package's standard Pi entry to DoomPi's shared Cordis host. */
export async function activateDoomPiEditExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(doomPiEditPlugin, { pi });
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

interface DoomPiEditPluginConfig {
  readonly pi: ExtensionAPI;
}

function doomPiEditPlugin(cordis: Context, config: DoomPiEditPluginConfig): void {
  installDoomPiEditRuntime(cordis, config.pi);
}

export default activateDoomPiEditExtension;
