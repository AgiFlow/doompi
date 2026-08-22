import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import {
  DOOM_TOOL_OVERRIDES_SERVICE,
  requireDoomToolOverrides,
} from '@agimon-ai/doompi-extension-contracts/tool-overrides';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerHashlineGrepTool } from './grepTool.ts';

const PACKAGE_SOURCE = '@agimon-ai/doompi-grep';

/** Install the hashline grep replacement after claiming its Pi tool name. */
export function installDoomPiGrepRuntime(cordis: Context, pi: ExtensionAPI): void {
  cordis.inject([DOOM_TOOL_OVERRIDES_SERVICE], (overridesContext) => {
    const registration = requireDoomToolOverrides(overridesContext).claim({
      source: PACKAGE_SOURCE,
      tools: ['grep'],
    });
    if (!registration.granted) return;
    try {
      registerHashlineGrepTool(pi);
    } catch (error) {
      registration.dispose();
      throw error;
    }
    return () => registration.dispose();
  });
}

/** Connect the package's standard Pi entry to DoomPi's shared Cordis host. */
export async function activateDoomPiGrepExtension(pi: ExtensionAPI): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(doomPiGrepPlugin, { pi });
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

interface DoomPiGrepPluginConfig {
  readonly pi: ExtensionAPI;
}

function doomPiGrepPlugin(cordis: Context, config: DoomPiGrepPluginConfig): void {
  installDoomPiGrepRuntime(cordis, config.pi);
}

export default activateDoomPiGrepExtension;
