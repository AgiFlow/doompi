import { RECORDING_STATE, RECORDING_FRAMES, TRANSCRIBING_FRAMES } from '../constants/voiceRuntime';
import type { VoiceActivityUpdate, AutoCaptureIndicatorState } from '../types';
export interface VoiceFooterContributionValue {
  fullText: string;
  compactText: string;
  fullSegments: Array<{ text: string; color: 'warning' | 'accent' }>;
  compactSegments: Array<{ text: string; color: 'warning' | 'accent' }>;
}

export interface VoiceActivityPresentation {
  statusText: string;
  footer: VoiceFooterContributionValue;
}

export interface AutoCaptureActivityPresentation {
  statusText: string;
  footer: VoiceFooterContributionValue;
}

export function formatVoiceActivity(update: VoiceActivityUpdate): VoiceActivityPresentation {
  const frames = update.state === RECORDING_STATE ? RECORDING_FRAMES : TRANSCRIBING_FRAMES;
  const frameIndex = Math.max(0, Math.floor(update.frameIndex)) % frames.length;
  const frame = frames[frameIndex]!;
  const color = update.state === RECORDING_STATE ? ('warning' as const) : ('accent' as const);
  const elapsed = Math.max(0, Math.floor(update.elapsedSeconds ?? 0));
  const statusText =
    update.state === RECORDING_STATE
      ? `${frame} voice: recording ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
      : `${frame} voice: transcribing`;
  return {
    statusText,
    footer: {
      fullText: frame,
      compactText: frame,
      fullSegments: [{ text: frame, color }],
      compactSegments: [{ text: frame, color }],
    },
  };
}

export function formatAutoCaptureActivity(state: AutoCaptureIndicatorState): AutoCaptureActivityPresentation {
  const presentation =
    state === 'listening'
      ? { frame: 'A', statusText: 'voice auto: listening', color: 'accent' as const }
      : state === 'speech'
        ? { frame: '!', statusText: 'voice auto: hearing speech', color: 'warning' as const }
        : state === 'processing'
          ? { frame: '…', statusText: 'voice auto: processing while listening', color: 'accent' as const }
          : state === 'narrating'
            ? { frame: 'A', statusText: 'voice auto: narrating and listening', color: 'accent' as const }
            : state === 'confirming'
              ? { frame: '?', statusText: 'voice auto: confirmation needed', color: 'warning' as const }
              : state === 'waiting'
                ? { frame: '…', statusText: 'voice auto: waiting for keyboard input', color: 'warning' as const }
                : { frame: 'A', statusText: 'voice auto: draining', color: 'warning' as const };
  return {
    statusText: presentation.statusText,
    footer: {
      fullText: presentation.frame,
      compactText: presentation.frame,
      fullSegments: [{ text: presentation.frame, color: presentation.color }],
      compactSegments: [{ text: presentation.frame, color: presentation.color }],
    },
  };
}
