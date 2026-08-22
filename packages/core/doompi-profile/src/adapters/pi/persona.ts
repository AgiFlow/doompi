import fs from 'node:fs';
import { requireDoomConfigContext } from '@agimon-ai/doompi-config';
import { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-extension-contracts/config';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { PROFILE_EVENT, type ProfileTelemetry } from '../../types/telemetry.ts';
import { createProfileTelemetry } from '../telemetry/logSinkTelemetry.ts';

/**
 * Appends the selected profile's persona to the system prompt.
 *
 * The harness writes the assembled persona to a file in the run directory and
 * records the path in the harness state, so agents/ stays the single source of
 * persona material and is never copied into config.
 *
 * This is a separate Pi entry from the /profile command because detached
 * children need the persona without the command: they have no transition
 * coordinator to run a switch through.
 */
const PACKAGE_SOURCE = '@agimon-ai/doompi-profile/persona';

interface PersonaPluginConfig {
  readonly pi: ExtensionAPI;
  readonly telemetry: ProfileTelemetry;
}

function personaPlugin(cordis: Context, { pi, telemetry }: PersonaPluginConfig): void {
  let activeContext: Context | undefined;
  cordis.inject([DOOM_CONFIG_SERVICE], (context) => {
    activeContext = context;
    return () => {
      if (activeContext === context) activeContext = undefined;
    };
  });
  registerPersonaHandlers(pi, telemetry, () => {
    if (!activeContext) throw new Error('Doom persona runtime is waiting for the session config service.');
    return activeContext;
  });
}

export function registerPersonaHandlers(
  pi: ExtensionAPI,
  telemetry: ProfileTelemetry,
  cordisContext: () => Context,
): void {
  pi.on('before_agent_start', async (event, _ctx) => {
    const { personaFile } = requireDoomConfigContext(cordisContext()).harness;
    if (!personaFile) return undefined;

    try {
      const content = (await fs.promises.readFile(personaFile, 'utf8')).trim();
      return content ? { systemPrompt: `${event.systemPrompt}\n\n${content}` } : undefined;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void telemetry.recordError(PROFILE_EVENT.personaReadFailed, error);
      process.stderr.write(`[pi-persona] could not read ${personaFile}: ${reason}\n`);
      return undefined;
    }
  });
}

export async function personaExtension(
  pi: ExtensionAPI,
  telemetry: ProfileTelemetry = createProfileTelemetry(),
): Promise<void> {
  const connection = await connectDoomCordisHost(pi, PACKAGE_SOURCE);
  const fiber = connection.root.plugin(personaPlugin, { pi, telemetry });
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

export default personaExtension;
