import type { PiPluginContext, PiToolDeclaration } from '@agimon-ai/doompi-core/pi-extension';

import type { createUiRuntime } from '../../../../../tui/uiRuntime';

export interface UiPiScope {
  readonly ui: ReturnType<typeof createUiRuntime>;
  readonly tools: readonly PiToolDeclaration[];
  readonly runtime: NonNullable<PiPluginContext['runtime']>;
}
