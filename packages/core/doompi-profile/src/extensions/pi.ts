import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';
import { createProfileRuntime } from '../controllers/profileRuntime';
import { createProfileTelemetry } from '../services/logSinkTelemetry';
import type { ProfileTelemetry } from '../types/telemetry';
const PACKAGE_SOURCE = '@agimon-ai/doompi-profile';
export const profileExtension = definePiExtension<ProfileTelemetry>(PACKAGE_SOURCE, ({ pi, options }) => ({
  ...createProfileRuntime({ pi, telemetry: options ?? createProfileTelemetry() }),
  resources: [
    {
      source: PACKAGE_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-author-profile',
          description:
            'Configure DoomPi profile discovery, personas, environment defaults, and precedence in profiles.yaml. Use when creating or changing personal or repository profiles. Do not use for config.yaml runtime settings, modes.yaml, or domains.yaml.',
        },
      ],
    },
  ],
}));
export default profileExtension;
