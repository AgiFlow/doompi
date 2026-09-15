import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { createDomainTelemetry } from '../../../../services/logSinkTelemetry';
import type { DomainTelemetry } from '../../../../types/telemetry';
import { createDomainRuntime } from './_lib/domainRuntime';

export default defineRoot(({ pi, options }: PiPluginContext<DomainTelemetry>) => {
  const runtime = createDomainRuntime({ pi, telemetry: options ?? createDomainTelemetry() });
  return { value: runtime, services: runtime.services, onStop: runtime.onStop, onDispose: runtime.onDispose };
});
