import type { WebPluginSlotProps } from '@agimon-ai/doompi-core/web';
import {
  AlertIcon,
  Button,
  LoaderIcon,
  MicIcon,
  StopIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@agimon-ai/doompi-web-components';
import { useStore } from '@tanstack/react-store';
import { useEffect, useRef, useState } from 'react';

import { startManualBrowserRecording } from '../api/manualBrowserRecorder';
import { ManualComposerRecorder, type ManualComposerRecorderState } from '../api/manualComposerRecorder';
import { transcribeManualRecording } from '../api/manualTranscriptionClient';
import { voiceActivityView } from '../lib/voiceActivityView';
import { activeVoiceSession } from '../stores/voiceMediaWakeStore';
import {
  voiceMicrophoneConstraints,
  watchVoiceMicrophones,
  discoverVoiceMicrophones,
  refreshVoiceMicrophones,
  selectVoiceMicrophone,
  voiceMicrophone,
} from '../stores/voiceMicrophoneStore';

const MANUAL_UNAVAILABLE_LABEL = 'manual voice is unavailable while autonomous voice is active';

/** Voice control in the composer action slot on desktop and mobile. */
export function VoiceComposerAction({ sessionId, appendComposerDraft, statuses }: WebPluginSlotProps) {
  const microphone = useStore(voiceMicrophone.store, (state) => state);
  const [deviceError, setDeviceError] = useState<string>();
  const reportDeviceError = (error: unknown): void =>
    setDeviceError(error instanceof Error ? error.message : String(error));
  const ownedSession = useStore(activeVoiceSession.store, (state) => state);
  const view = voiceActivityView(statuses['doom-voice']);
  // The recorder publishes into state rather than being read during render, so the
  // button re-renders from the phase it last announced.
  const [manualState, setManualState] = useState<ManualComposerRecorderState>({ phase: 'idle' });
  const manualRecorder = useRef<ManualComposerRecorder | undefined>(undefined);
  manualRecorder.current ??= new ManualComposerRecorder(
    appendComposerDraft,
    () => {
      setManualState(manualRecorder.current?.snapshot() ?? { phase: 'idle' });
    },
    {
      start: async () => startManualBrowserRecording(undefined, await voiceMicrophoneConstraints()),
      transcribe: (audio, id, duration, signal) => transcribeManualRecording(audio, id, duration, undefined, signal),
    },
  );
  const manualPhase = manualState.phase;
  const manualError = manualState.error;
  const autonomous = view.mode === 'auto' || ownedSession !== null;

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

  useEffect(() => {
    const changed = (): void => {
      void refreshVoiceMicrophones().catch(reportDeviceError);
    };
    return watchVoiceMicrophones(changed);
  }, []);

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
    <div className="flex items-center gap-1">
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
      {microphone.inputs.length > 0 ? (
        <Select
          value={microphone.deviceId ?? ''}
          disabled={autonomous || manualPhase !== 'idle' || microphone.busy}
          onValueChange={(value) => {
            setDeviceError(undefined);
            void selectVoiceMicrophone(value).catch(reportDeviceError);
          }}
        >
          <SelectTrigger
            aria-label="Voice microphone"
            data-testid="voice-microphone-picker"
            className="max-w-36 text-xs"
          >
            <SelectValue placeholder="Choose microphone" />
          </SelectTrigger>
          <SelectContent>
            {microphone.inputs.map((input) => (
              <SelectItem key={input.deviceId} value={input.deviceId}>
                {input.label || 'Microphone'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Button
          variant="outline"
          disabled={autonomous || manualPhase !== 'idle' || microphone.busy}
          onClick={() => {
            setDeviceError(undefined);
            void discoverVoiceMicrophones().catch(reportDeviceError);
          }}
        >
          Microphone
        </Button>
      )}
      {(manualError || deviceError || microphone.error) && (
        <span role="alert" className="max-w-64 text-xs text-doom-yellow">
          {manualError || deviceError || microphone.error}
        </span>
      )}
    </div>
  );
}
