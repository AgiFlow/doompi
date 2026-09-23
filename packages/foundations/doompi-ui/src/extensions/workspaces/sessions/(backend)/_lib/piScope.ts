import type { PiPluginContext, PiToolDeclaration } from '@agimon-ai/doompi-core/piExtension';

import type { createUiRuntime } from '../../../../../tui/uiRuntime';

export interface UiPiScope {
  readonly ui: ReturnType<typeof createUiRuntime>;
  readonly tools: readonly PiToolDeclaration[];
  readonly runtime: NonNullable<PiPluginContext['runtime']>;
}
