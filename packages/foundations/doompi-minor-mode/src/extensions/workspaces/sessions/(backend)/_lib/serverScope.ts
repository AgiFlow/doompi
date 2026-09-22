import type { DoomHeadlessCommand, DoomHeadlessHook } from '@agimon-ai/doompi-core/headless';
import type { DoomServerPluginContext } from '@agimon-ai/doompi-core/serverFacet';

export interface MinorModeServerScope {
  readonly commands: readonly DoomHeadlessCommand[];
  readonly hooks: readonly DoomHeadlessHook[];
  readonly services: readonly ((context: DoomServerPluginContext['context']) => void)[];
}
