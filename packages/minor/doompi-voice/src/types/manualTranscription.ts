import type { ResolvedVoiceConfig } from '@agimon-ai/doompi-config';

export const MANUAL_TRANSCRIPTION_ROUTE = '/manual/transcribe';
export const MANUAL_TRANSCRIPTION_DURATION_HEADER = 'x-doom-audio-duration-ms';
export const MANUAL_TRANSCRIPTION_MAX_AUDIO_BYTES = 4 * 1024 * 1024;
export const MANUAL_TRANSCRIPTION_MAX_DURATION_MS = 300_000;
export const MANUAL_TRANSCRIPTION_MAX_TRANSCRIPT_BYTES = 16 * 1024;
export const MANUAL_TRANSCRIPTION_DECODE_TIMEOUT_MS = 30_000;
export const MANUAL_TRANSCRIPTION_TIMEOUT_MS = 60_000;

export type ManualTranscriptionMediaType = 'audio/webm' | 'audio/mp4';
export type ManualTranscriptionErrorKind =
  | 'empty_transcript'
  | 'invalid_audio'
  | 'output_too_large'
  | 'timeout'
  | 'unavailable';

export class ManualTranscriptionError extends Error {
  public constructor(
    public readonly kind: ManualTranscriptionErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'ManualTranscriptionError';
  }
}

export interface ManualTranscriptionResult {
  transcript: string;
}

export interface IManualTranscriptionConfigLoader {
  load(): ResolvedVoiceConfig;
}

export interface IEncodedAudioDecoder {
  decode(
    audio: Buffer,
    mediaType: ManualTranscriptionMediaType,
    workspace: string,
    configuredBinary?: string,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface IManualTranscriptionService {
  transcribe(
    audio: Buffer,
    mediaType: ManualTranscriptionMediaType,
    signal?: AbortSignal,
  ): Promise<ManualTranscriptionResult>;
}
