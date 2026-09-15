import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { createMajorModeTelemetry } from '../../../../services/logSinkTelemetry';
import type { MajorModeTelemetry } from '../../../../types/telemetry';
import { createMajorModeRuntime } from './_lib/majorModeRuntime';
export default defineRoot(({ pi, options }: PiPluginContext<MajorModeTelemetry>) => {
  const runtime = createMajorModeRuntime({ pi, telemetry: options ?? createMajorModeTelemetry() });
  return { value: runtime, services: runtime.services, onStop: runtime.onStop, onDispose: runtime.onDispose };
});
