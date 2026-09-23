import { defineResource } from '@agimon-ai/doompi-core/extensionFile';

import { MAJOR_MODE_SOURCE } from '../../../../../types/majorMode';
export default defineResource({
  source: MAJOR_MODE_SOURCE,
  moduleUrl: import.meta.url,
  skills: [
    {
      name: 'doompi-author-major-mode',
      description:
        "Configure DoomPi default packages, layers, extensions, hook groups, and named major modes. Use when creating or editing ~/.pi/.doom/modes.yaml or a repository's .doom/modes.yaml, choosing a default mode, or diagnosing which behavior a mode activates.",
    },
  ],
});
