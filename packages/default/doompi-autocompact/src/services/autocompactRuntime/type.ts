import type { PiEventHandlers } from '@agimon-ai/doompi-core/pi-extension';
import type { Context } from '@deepseek-ai/cordis';
export interface AutocompactRuntime {
  readonly plugin: (this: void, context: Context) => void;
  readonly events: PiEventHandlers;
  stop(this: void): Promise<void>;
}
