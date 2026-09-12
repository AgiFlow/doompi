import fs from 'node:fs';
import { requireDoomConfigContext } from '@agimon-ai/doompi-config';
import { DOOM_CONFIG_SERVICE } from '@agimon-ai/doompi-core/config';
import { type PiEventHandlers, type PiPluginContributions } from '@agimon-ai/doompi-core/pi-extension';
import type { Context } from '@deepseek-ai/cordis';
import { PROFILE_EVENT, type ProfileTelemetry } from '../types/telemetry';

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

export function createPersonaEvents(telemetry: ProfileTelemetry, cordisContext: () => Context): PiEventHandlers {
  return {
    before_agent_start: async (event, _ctx) => {
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
    },
  };
}

export function createPersonaRuntime(telemetry: ProfileTelemetry): PiPluginContributions<ProfileTelemetry> {
  let activeContext: Context | undefined;
  return {
    services: [
      (cordis: Context) => {
        cordis.inject([DOOM_CONFIG_SERVICE], (context) => {
          activeContext = context;
          return () => {
            if (activeContext === context) activeContext = undefined;
          };
        });
      },
    ],
    events: createPersonaEvents(telemetry, () => {
      if (!activeContext) throw new Error('Doom persona runtime is waiting for the session config service.');
      return activeContext;
    }),
  };
}
