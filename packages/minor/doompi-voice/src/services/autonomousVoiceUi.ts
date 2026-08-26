import type { AutoCaptureIndicatorState } from '../types/index.ts';
import { autonomousVoiceState, type AutonomousVoiceSnapshot } from './autonomousVoiceMachine.ts';

export interface AutonomousVoiceUiProjectionOptions {
  modalBlocked: boolean;
  confirmationPending: boolean;
}

export interface AutonomousVoiceUiProjection {
  indicator: AutoCaptureIndicatorState | undefined;
  status: string | undefined;
}

export function projectAutonomousVoiceUi(
  snapshot: AutonomousVoiceSnapshot,
  options: AutonomousVoiceUiProjectionOptions,
): AutonomousVoiceUiProjection {
  if (autonomousVoiceState(snapshot) === 'off') return { indicator: undefined, status: undefined };
  if (snapshot.matches('failed')) return { indicator: 'draining', status: 'voice auto: error' };
  if (snapshot.matches('stopping') || snapshot.context.stopRequested)
    return { indicator: 'draining', status: 'voice auto: stopping' };
  if (snapshot.matches({ active: { playback: 'playing' } }))
    return { indicator: 'narrating', status: 'voice auto: narrating' };
  if (options.modalBlocked) return { indicator: 'waiting', status: 'voice auto: waiting for keyboard input' };
  if (options.confirmationPending) return { indicator: 'confirming', status: 'voice auto: confirmation needed' };
  const state = autonomousVoiceState(snapshot);
  if (snapshot.context.compositionState === 'submitting')
    return { indicator: 'processing', status: 'voice auto: sending composed prompt' };
  if (snapshot.context.compositionState === 'collecting') {
    if (state === 'starting') return { indicator: 'processing', status: 'voice auto: composing, starting capture' };
    if (state === 'listening') return { indicator: 'listening', status: 'voice auto: composing, listening' };
    if (state === 'speech') return { indicator: 'speech', status: 'voice auto: composing, hearing speech' };
    return { indicator: 'processing', status: 'voice auto: composing, processing' };
  }
  if (state === 'starting') return { indicator: 'processing', status: 'voice auto: starting' };
  if (state === 'listening') return { indicator: 'listening', status: 'voice auto: listening' };
  if (state === 'speech') return { indicator: 'speech', status: 'voice auto: hearing speech' };
  return { indicator: 'processing', status: 'voice auto: processing' };
}
