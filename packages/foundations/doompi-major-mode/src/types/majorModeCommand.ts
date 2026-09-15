import type { VoiceReloadHandoffStore } from '@agimon-ai/doompi-core/voice-reload-handoff';
import type { Context } from '@deepseek-ai/cordis';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { MajorModeView } from './majorMode';

export interface MajorModeCommandDependencies {
  readonly cordisContext: () => Context;
  readonly currentView: (ctx: ExtensionContext) => Promise<MajorModeView>;
  readonly reloadHandoffs: VoiceReloadHandoffStore;
  readonly loadPicker: () => Promise<typeof import('@agimon-ai/doompi-ui/matrix-picker')>;
  readonly loadSelectionSwitch: () => Promise<typeof import('@agimon-ai/doompi-config/selectionSwitch')>;
  readonly loadConfigJournal: () => Promise<typeof import('@agimon-ai/doompi-config/piContext')>;
  readonly resolveLayers: (config: MajorModeView['config'], majorMode: string) => string[];
  /** Whether an owning process supervisor listens for relaunch requests. */
  readonly supervisedRelaunchAvailable: () => boolean;
  /** Asks the supervisor to relaunch with the picked mode; call only at idle. */
  readonly requestSupervisedRelaunch: (majorMode: string, operationId: string) => boolean;
}
