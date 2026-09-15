import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';

import type { ProfileTelemetry } from '../../types/telemetry';
import { createProfileTelemetry } from '../logSinkTelemetry';
import { createPersonaRuntime } from './runtime';
export const personaExtension = definePiExtension<ProfileTelemetry>(
  '@agimon-ai/doompi-profile/persona',
  ({ options }) => createPersonaRuntime(options ?? createProfileTelemetry()),
);
export default personaExtension;
