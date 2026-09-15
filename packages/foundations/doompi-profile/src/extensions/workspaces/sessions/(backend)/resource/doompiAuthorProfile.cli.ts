import { defineResource } from '@agimon-ai/doompi-core/extension-file';
const PACKAGE_SOURCE = '@agimon-ai/doompi-profile';
export default defineResource({
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
