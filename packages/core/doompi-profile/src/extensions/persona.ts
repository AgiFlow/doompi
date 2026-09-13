import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';

import { createPersonaRuntime } from '../controllers/personaRuntime';
import { createProfileTelemetry } from '../services/logSinkTelemetry';
import type { ProfileTelemetry } from '../types/telemetry';
export const personaExtension = definePiExtension<ProfileTelemetry>(
  '@agimon-ai/doompi-profile/persona',
  ({ options }) => createPersonaRuntime(options ?? createProfileTelemetry()),
);
export default personaExtension;
