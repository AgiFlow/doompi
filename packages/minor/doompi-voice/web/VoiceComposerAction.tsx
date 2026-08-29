import {
  AlertIcon,
  AudioLinesIcon,
  Button,
  LoaderIcon,
  MessageIcon,
  MicIcon,
  SendIcon,
  StopIcon,
  VolumeIcon,
} from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useStore } from '@tanstack/react-store';
import type { VoicePhase, VoiceTone } from './voiceActivityView.ts';
import { voiceActivityView } from './voiceActivityView.ts';
import { voiceMediaBrowserState } from './voiceMediaWakeStore.ts';

const TONE_TEXT: Readonly<Record<VoiceTone, string>> = {
  idle: 'text-doom-dim',
  live: 'text-doom-cyan',
  attention: 'text-doom-yellow',
};

function VoicePhaseIcon({ phase }: { phase: VoicePhase }) {
  switch (phase) {
    case 'hearing':
      return <AudioLinesIcon className="h-3.5 w-3.5" />;
    case 'processing':
    case 'transcribing':
    case 'draining':
      return <LoaderIcon className="h-3.5 w-3.5 animate-spin" />;
    case 'composing':
      return <MessageIcon className="h-3.5 w-3.5" />;
    case 'sending':
      return <SendIcon className="h-3.5 w-3.5" />;
    case 'narrating':
      return <VolumeIcon className="h-3.5 w-3.5" />;
    case 'confirming':
    case 'waiting':
      return <AlertIcon className="h-3.5 w-3.5" />;
    case 'idle':
    case 'starting':
    case 'muted':
    case 'listening':
    case 'recording':
      return <MicIcon className="h-3.5 w-3.5" />;
  }
}

/** Compact voice control for the mobile composer action slot. */
export function VoiceComposerAction({ sessionId, sendSessionFrame, statuses }: WebPluginSlotProps) {
  const view = voiceActivityView(statuses['doom-voice']);
  const browserState = useStore(voiceMediaBrowserState.store);
  const mediaConflict =
    sessionId !== null &&
    browserState?.sessionId === sessionId &&
    browserState.phase === 'conflict' &&
    view.mode !== 'off';
  const recording = view.mode === 'manual' && view.phase === 'recording';
  const stoppingAuto = view.mode === 'auto' && view.phase === 'draining';
  const command =
    view.mode === 'off' || recording
      ? '/voice'
      : view.mode === 'auto' && !stoppingAuto
        ? '/minor voice-auto deactivate'
        : null;
  const label = mediaConflict
    ? 'microphone unavailable: another browser tab owns voice capture'
    : view.mode === 'off'
      ? 'start voice recording'
      : recording
        ? 'stop voice recording and fill the prompt'
        : view.mode === 'auto'
          ? `${stoppingAuto ? '' : 'stop '}autonomous voice: ${view.label}`
          : view.label;

  const act = (): void => {
    if (sessionId !== null && command !== null) sendSessionFrame(sessionId, { type: 'prompt', message: command });
  };

  return (
    <Button
      variant={recording ? 'danger-outline' : 'outline'}
      size="icon"
      data-testid="composer-voice-action"
      data-voice-mode={view.mode}
      data-voice-phase={mediaConflict ? 'conflict' : view.phase}
      aria-label={label}
      title={label}
      disabled={sessionId === null || command === null}
      onClick={act}
      className={`shrink-0 ${TONE_TEXT[mediaConflict ? 'attention' : view.tone]}`}
    >
      {mediaConflict ? (
        <AlertIcon className="h-3.5 w-3.5" />
      ) : recording ? (
        <StopIcon className="h-3 w-3 fill-current" />
      ) : (
        <VoicePhaseIcon phase={view.phase} />
      )}
    </Button>
  );
}
