import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { CACHE_HELP_SKILL, PACKAGE_SOURCE } from '../../../../constants/cache';
import { PromptCacheTelemetry } from '../../../../models/promptCacheTelemetry';
import { createCacheRuntime } from '../../../../services/cacheRuntime';
import type { OptimizerModule } from '../../../../services/cacheRuntime/type';
import { PromptCacheTelemetryService } from '../../../../services/promptCacheTelemetry';
import type { CacheExtensionDependencies } from '../../../../types/extension';

export default async ({ pi, options }: PiPluginContext<CacheExtensionDependencies>) => {
  const dependencies = options ?? { telemetry: new PromptCacheTelemetry(), now: Date.now };
  const optimizer: OptimizerModule = await import('#doompi-cache-optimizer-source');
  if (typeof optimizer.default !== 'function')
    throw new Error('Pi Cache Optimizer does not export an extension factory.');
  await optimizer.default(pi);
  const runtime = createCacheRuntime(dependencies, optimizer);
  return {
    services: [
      (context: PiPluginContext['context']) => {
        new PromptCacheTelemetryService(context, dependencies.telemetry);
      },
      runtime.plugin,
    ],
    events: runtime.events,
    resources: [{ source: PACKAGE_SOURCE, moduleUrl: import.meta.url, skills: [CACHE_HELP_SKILL] }],
    onDispose() {
      runtime.dispose();
    },
  };
};
