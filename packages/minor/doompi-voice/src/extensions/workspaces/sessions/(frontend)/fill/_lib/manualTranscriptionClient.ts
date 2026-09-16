import { voiceMedia } from '../../../../../../../generated/client';
import {
  MANUAL_TRANSCRIPTION_DURATION_HEADER,
  MANUAL_TRANSCRIPTION_MAX_AUDIO_BYTES,
  MANUAL_TRANSCRIPTION_MAX_DURATION_MS,
  type ManualTranscriptionResult,
} from '../../../../../../types/manualTranscription';

function transcriptOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('transcript' in value)) return undefined;
  const transcript = (value as Partial<ManualTranscriptionResult>).transcript;
  return typeof transcript === 'string' ? transcript : undefined;
}

/** Sends one complete browser recording through the page's sealed transport. */
export async function transcribeManualRecording(
  audio: Blob,
  sessionId: string,
  durationMs: number,
  signal?: AbortSignal,
): Promise<string> {
  if (audio.size === 0) throw new Error('The recording is empty.');
  if (audio.size > MANUAL_TRANSCRIPTION_MAX_AUDIO_BYTES) {
    throw new Error('The recording exceeds the 4 MiB transcription limit.');
  }
  if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > MANUAL_TRANSCRIPTION_MAX_DURATION_MS) {
    throw new Error('The recording duration is invalid.');
  }
  // The Blob goes through the declared call untouched: the client encodes only
  // what is not already a body the sealed relay can carry, and a recording is.
  const result = await voiceMedia.session(sessionId).manualTranscribe({
    headers: {
      'content-type': audio.type,
      [MANUAL_TRANSCRIPTION_DURATION_HEADER]: String(durationMs),
    },
    body: audio,
    ...(signal === undefined ? {} : { signal }),
  });
  const transcript = transcriptOf(result.data);
  if (!result.ok) {
    throw new Error(
      result.error === '' ? `Voice transcription failed with status ${String(result.status)}.` : result.error,
    );
  }
  if (transcript === undefined) throw new Error('Voice transcription returned an invalid response.');
  return transcript;
}
