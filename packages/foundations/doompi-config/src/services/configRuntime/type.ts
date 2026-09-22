import type { PiEventHandlers } from '@agimon-ai/doompi-core/piExtension';
import type { Context } from '@deepseek-ai/cordis';

export interface ConfigRuntime {
  plugin(this: void, context: Context): void;
  readonly onSessionStart: NonNullable<PiEventHandlers['session_start']>;
}
