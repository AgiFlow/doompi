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
import { useEffect, useRef, useState } from 'react';
import { ManualComposerRecorder } from './manualComposerRecorder.ts';
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

/** Voice control in the composer action slot on desktop and mobile. */
export function VoiceComposerAction({
  sessionId,
  appendComposerDraft,
  sendSessionFrame,
  statuses,
}: WebPluginSlotProps) {
  const view = voiceActivityView(statuses['doom-voice']);
  const browserState = useStore(voiceMediaBrowserState.store);
  const [, renderManualState] = useState(0);
  const manualRecorder = useRef<ManualComposerRecorder | undefined>(undefined);
  manualRecorder.current ??= new ManualComposerRecorder(appendComposerDraft, () =>
    renderManualState((version) => version + 1),
  );
  const manualState = manualRecorder.current.snapshot();
  const manualPhase = manualState.phase;
  const manualError = manualState.error;
  const autonomous = view.mode === 'auto';

  useEffect(() => {
    const recorder = manualRecorder.current;
    return () => recorder?.dispose();
  }, []);

  useEffect(() => {
    manualRecorder.current?.setAppend(appendComposerDraft);
  }, [appendComposerDraft]);

  useEffect(() => {
    manualRecorder.current?.reset();
  }, [sessionId, autonomous]);

  const mediaConflict =
    sessionId !== null &&
    browserState?.sessionId === sessionId &&
    browserState.phase === 'conflict' &&
    view.mode !== 'off';
  const stoppingAuto = view.mode === 'auto' && view.phase === 'draining';
  const autonomousCommand = view.mode === 'auto' && !stoppingAuto ? '/minor voice-auto deactivate' : null;

  const act = (): void => {
    if (autonomous) {
      if (sessionId !== null && autonomousCommand !== null) {
        sendSessionFrame(sessionId, { type: 'prompt', message: autonomousCommand });
      }
      return;
    }
    void manualRecorder.current?.toggle(sessionId);
  };

  const recording = !autonomous && manualPhase === 'recording';
  const label = autonomous
    ? mediaConflict
      ? 'microphone unavailable: another browser tab owns voice capture'
      : `${stoppingAuto ? '' : 'stop '}autonomous voice: ${view.label}`
    : (manualError ??
      (recording
        ? 'stop voice recording and fill the prompt'
        : manualPhase === 'transcribing'
          ? 'transcribing voice recording'
          : manualPhase === 'starting'
            ? 'starting voice recording'
            : 'start voice recording'));
  const phase = autonomous ? (mediaConflict ? 'conflict' : view.phase) : manualPhase;
  const tone = autonomous
    ? TONE_TEXT[mediaConflict ? 'attention' : view.tone]
    : TONE_TEXT[manualError ? 'attention' : 'idle'];

  return (
    <>
      <Button
        variant={recording ? 'danger-outline' : 'outline'}
        size="icon"
        data-testid="composer-voice-action"
        data-voice-mode={autonomous ? 'auto' : recording ? 'manual' : 'off'}
        data-voice-phase={phase}
        aria-label={label}
        title={label}
        disabled={
          sessionId === null ||
          (autonomous ? autonomousCommand === null : manualPhase === 'starting' || manualPhase === 'transcribing')
        }
        onClick={act}
        className={`shrink-0 ${tone}`}
      >
        {mediaConflict && autonomous ? (
          <AlertIcon className="h-3.5 w-3.5" />
        ) : recording ? (
          <StopIcon className="h-3 w-3 fill-current" />
        ) : manualPhase === 'starting' || manualPhase === 'transcribing' ? (
          <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
        ) : autonomous ? (
          <VoicePhaseIcon phase={view.phase} />
        ) : manualError ? (
          <AlertIcon className="h-3.5 w-3.5" />
        ) : (
          <MicIcon className="h-3.5 w-3.5" />
        )}
      </Button>
      {manualError && !autonomous ? (
        <span
          role="status"
          data-testid="composer-voice-error"
          className="max-w-32 truncate text-[9px] text-doom-yellow"
        >
          {manualError}
        </span>
      ) : null}
    </>
  );
}
