import type { MinorModeState } from '@agimon-ai/doompi-minor-mode';
import type { DoomToolRestriction } from '@agimon-ai/doompi-core/tool-surface';
import type { ComputerUseSessionView } from '../types/computerUseApi';
import { COMPUTER_USE_TOOL_NAMES } from '../constants/computerUse';
export function modeState(state?: ComputerUseSessionView, enabled = false): MinorModeState {
  const phase = state?.phase ?? 'inactive';
  const running = phase !== 'inactive' && phase !== 'failed';
  const modeEnabled = enabled || running;
  const activation = modeEnabled
    ? phase === 'stopping'
      ? 'deactivating'
      : phase === 'awaiting_confirmation' || phase === 'activating'
        ? 'activating'
        : 'active'
    : 'inactive';
  return {
    activation,
    condition:
      phase === 'awaiting_confirmation'
        ? 'blocked'
        : phase === 'failed'
          ? 'failed'
          : phase === 'activating' || phase === 'stopping'
            ? 'queued'
            : 'ready',
    ...(modeEnabled && phase === 'inactive' ? { detail: 'configure computer use in Activity' } : {}),
    ...(phase === 'awaiting_confirmation' ? { detail: 'awaiting confirmation in Activity' } : {}),
    actions: [
      {
        id: 'activate',
        enabled: !modeEnabled,
        ...(!modeEnabled ? {} : { disabledReason: 'Computer use is already enabled.' }),
      },
      {
        id: 'deactivate',
        enabled: modeEnabled,
        ...(modeEnabled ? {} : { disabledReason: 'Computer use is not enabled.' }),
      },
      { id: 'doctor', enabled: true },
    ],
  };
}

/**
 * Hides the computer-use tools while the mode is off.
 *
 * The arbiter starts from every registered tool, so an active mode only has to
 * return the list untouched: nothing has to add the tools back.
 */
export function computerUseRestriction(active: boolean): DoomToolRestriction {
  const owned = new Set<string>(COMPUTER_USE_TOOL_NAMES);
  return (incoming) => (active ? incoming : incoming.filter((name) => !owned.has(name)));
}
