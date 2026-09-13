import type { PiEventHandlers } from '@agimon-ai/doompi-core/pi-extension';
import type { Context } from '@deepseek-ai/cordis';
export type OptimizerModule = typeof import('#doompi-cache-optimizer-source');
export interface CacheRuntime {
  readonly plugin: (this: void, context: Context) => void;
  readonly events: PiEventHandlers;
  dispose(): void;
}
