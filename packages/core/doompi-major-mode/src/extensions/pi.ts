import { definePiExtension } from '@agimon-ai/doompi-extension-contracts/pi-extension';
import { createMajorModeRuntime } from '../controllers/majorModeRuntime';
import { createMajorModeTelemetry } from '../services/logSinkTelemetry';
import { MAJOR_MODE_SOURCE } from '../types/majorMode';
import type { MajorModeTelemetry } from '../types/telemetry';

export const majorModeExtension = definePiExtension<MajorModeTelemetry>(MAJOR_MODE_SOURCE, ({ pi, options }) => ({
  ...createMajorModeRuntime({ pi, telemetry: options ?? createMajorModeTelemetry() }),
  resources: [
    {
      source: MAJOR_MODE_SOURCE,
      moduleUrl: import.meta.url,
      skills: [
        {
          name: 'doompi-author-major-mode',
          description:
            "Configure DoomPi default packages, layers, extensions, hook groups, and named major modes. Use when creating or editing ~/.pi/.doom/modes.yaml or a repository's .doom/modes.yaml, choosing a default mode, or diagnosing which behavior a mode activates.",
        },
      ],
    },
  ],
}));
export default majorModeExtension;
