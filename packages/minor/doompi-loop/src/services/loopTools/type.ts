import type { DoomPluginTool } from '@agimon-ai/doompi-core/piExtension';

/** Shared root state read by the named CLI and server tool routes. */
export interface LoopToolsRoot {
  readonly loopTools: readonly DoomPluginTool[];
}
