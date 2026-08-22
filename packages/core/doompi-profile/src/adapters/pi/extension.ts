import { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-extension-contracts/config';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import { DOOM_HELP_SERVICE, requireDoomHelpService } from '@agimon-ai/doompi-extension-contracts/help';
import { DOOM_TRANSITION_SERVICE } from '@agimon-ai/doompi-extension-contracts/transition';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerProfileCommand } from '../../commands/profileCommand.ts';
import type { ProfileTelemetry } from '../../types/telemetry.ts';
import { createProfileTelemetry } from '../telemetry/logSinkTelemetry.ts';

const PACKAGE_SOURCE = '@agimon-ai/doompi-profile';

/**
 * The package's single standard Pi factory.
 */
export async function profileExtension(
  pi: ExtensionAPI,
  telemetry: ProfileTelemetry = createProfileTelemetry(),
): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(profilePlugin, { pi, telemetry });
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

interface ProfilePluginConfig {
  readonly pi: ExtensionAPI;
  readonly telemetry: ProfileTelemetry;
}

function profilePlugin(cordis: Context, config: ProfilePluginConfig): void {
  cordis.inject([DOOM_HELP_SERVICE], (helpContext) => {
    const contribution = requireDoomHelpService(helpContext).register({
      source: PACKAGE_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-author-profile',
          description:
            'Configure DoomPi profile discovery, personas, environment defaults, and precedence in profiles.yaml. Use when creating or changing personal or repository profiles. Do not use for config.yaml runtime settings, modes.yaml, or domains.yaml.',
        },
      ],
    });
    return () => contribution.dispose();
  });

  let activeContext: Context | undefined;
  cordis.inject([DOOM_CONFIG_SERVICE, DOOM_TRANSITION_SERVICE], (context) => {
    activeContext = context;
    return () => {
      if (activeContext === context) activeContext = undefined;
    };
  });
  const requireRuntimeContext = (): Context => {
    if (!activeContext) throw new Error('Doom profile runtime is waiting for the session config service.');
    return activeContext;
  };
  cordis.effect(function* () {
    registerProfileCommand(config.pi, config.telemetry, requireRuntimeContext);
    yield () => undefined;
  }, PACKAGE_SOURCE);
}

export default profileExtension;
