import type { Context } from '@deepseek-ai/cordis';
import type { PiEventHandlers } from '@agimon-ai/doompi-extension-contracts/pi-extension';
export type OptimizerModule = typeof import('#doompi-cache-optimizer-source');
export interface CacheRuntime {
  readonly plugin: (this: void, context: Context) => void;
  readonly events: PiEventHandlers;
  dispose(): void;
}
