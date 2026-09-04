import { AlertIcon, Button, LoaderIcon, MicIcon, StopIcon } from '@agimon-ai/doompi-web-components';
import type { WebPluginSlotProps } from '@agimon-ai/doompi-web-contracts';
import { useEffect, useRef, useState } from 'react';
import { ManualComposerRecorder, type ManualComposerRecorderState } from './manualComposerRecorder.ts';
import { voiceActivityView } from './voiceActivityView.ts';

const MANUAL_UNAVAILABLE_LABEL = 'manual voice is unavailable while autonomous voice is active';

/** Voice control in the composer action slot on desktop and mobile. */
export function VoiceComposerAction({ sessionId, appendComposerDraft, statuses }: WebPluginSlotProps) {
  const view = voiceActivityView(statuses['doom-voice']);
  // The recorder publishes into state rather than being read during render, so the
  // button re-renders from the phase it last announced.
  const [manualState, setManualState] = useState<ManualComposerRecorderState>({ phase: 'idle' });
  const manualRecorder = useRef<ManualComposerRecorder | undefined>(undefined);
  manualRecorder.current ??= new ManualComposerRecorder(appendComposerDraft, () => {
    setManualState(manualRecorder.current?.snapshot() ?? { phase: 'idle' });
  });
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

  const act = (): void => {
    if (!autonomous) void manualRecorder.current?.toggle(sessionId);
  };

  const recording = !autonomous && manualPhase === 'recording';
  const label = autonomous
    ? MANUAL_UNAVAILABLE_LABEL
    : (manualError ??
      (recording
        ? 'stop voice recording and fill the prompt'
        : manualPhase === 'transcribing'
          ? 'transcribing voice recording'
          : manualPhase === 'starting'
            ? 'starting voice recording'
            : 'start voice recording'));
  const phase = autonomous ? 'blocked' : manualPhase;
  const tone = manualError && !autonomous ? 'text-doom-yellow' : 'text-doom-dim';

  return (
    <Button
      variant={recording ? 'danger-outline' : 'outline'}
      size="icon"
      data-testid="composer-voice-action"
      data-voice-mode={autonomous ? 'auto' : recording ? 'manual' : 'off'}
      data-voice-phase={phase}
      aria-label={label}
      title={label}
      disabled={sessionId === null || autonomous || manualPhase === 'starting' || manualPhase === 'transcribing'}
      onClick={act}
      className={`shrink-0 ${tone}`}
    >
      {recording ? (
        <StopIcon className="h-3 w-3 fill-current" />
      ) : manualPhase === 'starting' || manualPhase === 'transcribing' ? (
        <LoaderIcon className="h-3.5 w-3.5 animate-spin" />
      ) : manualError && !autonomous ? (
        <AlertIcon className="h-3.5 w-3.5" />
      ) : (
        <MicIcon className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}
