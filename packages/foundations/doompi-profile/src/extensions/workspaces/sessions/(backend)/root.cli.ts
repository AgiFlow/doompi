import { defineRoot } from '@agimon-ai/doompi-core/extensionFile';
import type { PiPluginContext } from '@agimon-ai/doompi-core/piExtension';

import { createProfileTelemetry } from '../../../../services/logSinkTelemetry';
import type { ProfileTelemetry } from '../../../../types/telemetry';
import { createProfileRuntime } from './_lib/profileRuntime';
export default defineRoot(({ pi, options }: PiPluginContext<ProfileTelemetry>) => {
  const runtime = createProfileRuntime({ pi, telemetry: options ?? createProfileTelemetry() });
  return { value: runtime, services: runtime.services, onStop: runtime.onStop, onDispose: runtime.onDispose };
});
