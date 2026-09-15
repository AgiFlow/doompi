import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';

/** The npm name this package registers its voice tool and contributions under. */
export const MAJOR_MODE_SOURCE = '@agimon-ai/doompi-major-mode';
/** Discriminates this package's reload handoffs from every other axis's. */
export const MAJOR_MODE_SWITCH_HANDOFF_KIND = 'major-mode-switch';

/** The selection as both the command and the voice tool need to see it. */
export interface MajorModeView {
  config: MajorModesConfig;
  majorMode: string;
  domains: readonly string[];
  profile?: string;
}
