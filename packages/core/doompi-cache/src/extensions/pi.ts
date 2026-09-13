import { definePiExtension } from '@agimon-ai/doompi-core/pi-extension';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { CACHE_HELP_SKILL, PACKAGE_SOURCE } from '../constants/cache';
import { PromptCacheTelemetry } from '../models/promptCacheTelemetry';
import { createCacheRuntime } from '../services/cacheRuntime';
import type { OptimizerModule } from '../services/cacheRuntime/type';
import { PromptCacheTelemetryService } from '../services/promptCacheTelemetry';
import type { CacheExtensionDependencies } from '../types/extension';

const cachePiExtension = definePiExtension<{ dependencies: CacheExtensionDependencies; optimizer: OptimizerModule }>(
  PACKAGE_SOURCE,
  ({ options }) => {
    if (!options) throw new Error('Cache optimizer must be initialized before installation.');
    const { dependencies, optimizer } = options;
    const runtime = createCacheRuntime(dependencies, optimizer);
    return {
      services: [
        (context) => {
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
  },
);

export async function activateCacheExtension(
  pi: ExtensionAPI,
  dependencies: CacheExtensionDependencies = { telemetry: new PromptCacheTelemetry(), now: Date.now },
): Promise<void> {
  const optimizer = await import('#doompi-cache-optimizer-source');
  if (typeof optimizer.default !== 'function')
    throw new Error('Pi Cache Optimizer does not export an extension factory.');
  await optimizer.default(pi);
  await cachePiExtension(pi, { dependencies, optimizer });
}
export default activateCacheExtension;
