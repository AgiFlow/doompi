import { defineRoot } from '@agimon-ai/doompi-core/extension-file';
import type { PiPluginContext } from '@agimon-ai/doompi-core/pi-extension';

import { PromptCacheTelemetry } from '../../../../models/promptCacheTelemetry';
import { createCacheRuntime } from '../../../../services/cacheRuntime';
import type { OptimizerModule } from '../../../../services/cacheRuntime/type';
import { PromptCacheTelemetryService } from '../../../../services/promptCacheTelemetry';
import type { CacheExtensionDependencies } from '../../../../types/extension';
export default defineRoot(async ({ pi, options }: PiPluginContext<CacheExtensionDependencies>) => {
  const dependencies = options ?? { telemetry: new PromptCacheTelemetry(), now: Date.now };
  const optimizer: OptimizerModule = await import('#doompi-cache-optimizer-source');
  if (typeof optimizer.default !== 'function')
    throw new Error('Pi Cache Optimizer does not provide an extension factory.');
  await optimizer.default(pi);
  const runtime = createCacheRuntime(dependencies, optimizer);
  return {
    value: runtime,
    services: [
      (context: PiPluginContext['context']) => {
        new PromptCacheTelemetryService(context, dependencies.telemetry);
      },
      runtime.plugin,
    ],
    onDispose: () => runtime.dispose(),
  };
});
