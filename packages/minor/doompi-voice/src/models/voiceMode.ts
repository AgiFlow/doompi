import { type MinorModeState } from '@agimon-ai/doompi-minor-mode';
import { type AutoCaptureActivationState, type VoiceState } from '../types';
import { AUTO_MODE_COLOR } from '../constants/voiceRuntime';

export function canRunVoice(context: { hasUI?: boolean } | undefined): boolean {
  return context?.hasUI === true;
}

export function voiceOwnershipState(
  manualState: VoiceState,
  autonomousState: AutoCaptureActivationState,
): AutoCaptureActivationState {
  return manualState === 'idle' ? autonomousState : 'active';
}

export function voiceModeState(state: AutoCaptureActivationState, canRun = false): MinorModeState {
  const active = state !== 'disabled';
  const transitioning = state === 'starting' || state === 'draining' || state === 'shuttingDown';
  return {
    activation:
      state === 'starting'
        ? 'activating'
        : state === 'draining' || state === 'shuttingDown'
          ? 'deactivating'
          : active
            ? 'active'
            : 'inactive',
    condition: transitioning ? 'queued' : 'ready',
    ...(active ? { detail: state, color: AUTO_MODE_COLOR } : {}),
    actions: !canRun
      ? [
          {
            id: 'activate',
            enabled: false,
            disabledReason: 'Autonomous voice needs a session that can show its indicator.',
          },
          {
            id: 'manual',
            enabled: false,
            disabledReason: 'Manual voice needs a session that can show its indicator.',
          },
          {
            id: 'deactivate',
            enabled: false,
            disabledReason: 'Autonomous voice needs a session that can show its indicator.',
          },
        ]
      : transitioning
        ? [
            { id: 'activate', enabled: false, disabledReason: 'Autonomous voice is transitioning.' },
            { id: 'manual', enabled: false, disabledReason: 'Autonomous voice is transitioning.' },
            { id: 'deactivate', enabled: false, disabledReason: 'Autonomous voice is transitioning.' },
          ]
        : [
            ...(active
              ? [{ id: 'activate', enabled: false, disabledReason: 'Autonomous voice is already enabled.' } as const]
              : [{ id: 'activate', enabled: true } as const]),
            ...(active
              ? [
                  {
                    id: 'manual',
                    enabled: false,
                    disabledReason: 'Disable autonomous voice before using manual voice.',
                  } as const,
                ]
              : [{ id: 'manual', enabled: true } as const]),
            ...(active
              ? [{ id: 'deactivate', enabled: true } as const]
              : [{ id: 'deactivate', enabled: false, disabledReason: 'Autonomous voice is disabled.' } as const]),
          ],
  };
}
