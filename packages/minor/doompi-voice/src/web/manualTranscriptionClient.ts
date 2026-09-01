import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import { voiceMediaClientUrl } from '../types/clientMedia.ts';
import {
  MANUAL_TRANSCRIPTION_DURATION_HEADER,
  MANUAL_TRANSCRIPTION_MAX_AUDIO_BYTES,
  MANUAL_TRANSCRIPTION_MAX_DURATION_MS,
  MANUAL_TRANSCRIPTION_ROUTE,
  type ManualTranscriptionResult,
} from '../types/manualTranscription.ts';

type RequestAudio = (input: string, init?: RequestInit) => Promise<Response>;

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
  request: RequestAudio = sealedTransport.fetch.bind(sealedTransport),
  signal?: AbortSignal,
): Promise<string> {
  if (audio.size === 0) throw new Error('The recording is empty.');
  if (audio.size > MANUAL_TRANSCRIPTION_MAX_AUDIO_BYTES) {
    throw new Error('The recording exceeds the 4 MiB transcription limit.');
  }
  if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > MANUAL_TRANSCRIPTION_MAX_DURATION_MS) {
    throw new Error('The recording duration is invalid.');
  }
  const response = await request(voiceMediaClientUrl(sessionId, MANUAL_TRANSCRIPTION_ROUTE), {
    method: 'POST',
    headers: {
      'content-type': audio.type,
      [MANUAL_TRANSCRIPTION_DURATION_HEADER]: String(durationMs),
    },
    body: audio,
    ...(signal === undefined ? {} : { signal }),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const transcript = transcriptOf(body);
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Voice transcription failed with status ${String(response.status)}.`;
    throw new Error(message);
  }
  if (transcript === undefined) throw new Error('Voice transcription returned an invalid response.');
  return transcript;
}
