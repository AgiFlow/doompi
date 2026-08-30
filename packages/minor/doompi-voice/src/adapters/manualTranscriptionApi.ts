import type { DoomApiHandler } from '@agimon-ai/doompi-extension-contracts/package-api';
import {
  MANUAL_TRANSCRIPTION_DURATION_HEADER,
  MANUAL_TRANSCRIPTION_MAX_AUDIO_BYTES,
  MANUAL_TRANSCRIPTION_MAX_DURATION_MS,
  MANUAL_TRANSCRIPTION_ROUTE,
  type IManualTranscriptionService,
  ManualTranscriptionError,
  type ManualTranscriptionMediaType,
} from '../types/manualTranscription.ts';

const SUPPORTED_CODECS: Record<ManualTranscriptionMediaType, readonly string[]> = {
  'audio/webm': ['opus'],
  'audio/mp4': ['mp4a.40.2', 'aac'],
};

export function normalizeManualTranscriptionMediaType(value: string | null): ManualTranscriptionMediaType | undefined {
  if (value === null) return undefined;
  const [rawType, ...parameters] = value.toLowerCase().split(';');
  const mediaType = rawType?.trim();
  if (mediaType !== 'audio/webm' && mediaType !== 'audio/mp4') return undefined;
  const codecParameter = parameters
    .map((parameter) => parameter.trim())
    .find((parameter) => parameter.startsWith('codecs='));
  if (codecParameter === undefined) return mediaType;
  const codecs = codecParameter
    .slice('codecs='.length)
    .replaceAll('"', '')
    .split(',')
    .map((codec) => codec.trim());
  return codecs.length === 1 && SUPPORTED_CODECS[mediaType].includes(codecs[0]!) ? mediaType : undefined;
}

async function readBoundedBody(request: Request): Promise<Buffer | undefined> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MANUAL_TRANSCRIPTION_MAX_AUDIO_BYTES) return undefined;
  if (request.body === null) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MANUAL_TRANSCRIPTION_MAX_AUDIO_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ code, error: message }, { status });
}

function validDuration(request: Request): boolean {
  const value = request.headers.get(MANUAL_TRANSCRIPTION_DURATION_HEADER);
  if (value === null || !/^\d+$/.test(value)) return false;
  const durationMs = Number(value);
  return Number.isSafeInteger(durationMs) && durationMs >= 0 && durationMs <= MANUAL_TRANSCRIPTION_MAX_DURATION_MS;
}

function transcriptionErrorResponse(error: unknown): Response {
  if (!(error instanceof ManualTranscriptionError))
    return errorResponse('transcription_failed', 'Voice transcription failed.', 500);
  switch (error.kind) {
    case 'empty_transcript':
      return errorResponse('empty_transcript', 'Voice transcription was empty.', 422);
    case 'invalid_audio':
      return errorResponse('invalid_audio', 'Audio recording is invalid.', 400);
    case 'output_too_large':
      return errorResponse('output_too_large', 'Voice transcription output is too large.', 502);
    case 'timeout':
      return errorResponse('timeout', 'Voice transcription timed out.', 504);
    case 'unavailable':
      return errorResponse('unavailable', 'Voice transcription is not configured.', 503);
  }
}

export class ManualTranscriptionApi implements DoomApiHandler {
  private active: AbortController | undefined;

  public constructor(private readonly service: IManualTranscriptionService) {}

  public async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== MANUAL_TRANSCRIPTION_ROUTE) return errorResponse('not_found', 'Not found.', 404);
    if (request.method !== 'POST') return errorResponse('method_not_allowed', 'Method not allowed.', 405);
    const mediaType = normalizeManualTranscriptionMediaType(request.headers.get('content-type'));
    if (mediaType === undefined)
      return errorResponse('unsupported_media_type', 'Audio must be WebM/Opus or MP4/AAC.', 415);
    if (!validDuration(request))
      return errorResponse('invalid_duration', 'Audio duration must be between 0 and 300000 milliseconds.', 400);
    if (this.active !== undefined)
      return errorResponse('transcription_busy', 'Voice transcription is already in progress.', 409);
    const active = new AbortController();
    const abort = (): void => active.abort();
    this.active = active;
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    try {
      let audio: Buffer | undefined;
      try {
        audio = await readBoundedBody(request);
      } catch {
        return errorResponse('invalid_body', 'Audio upload could not be read.', 400);
      }
      if (audio === undefined) return errorResponse('payload_too_large', 'Audio exceeds the 4 MiB limit.', 413);
      if (audio.length === 0) return errorResponse('empty_audio', 'Audio must not be empty.', 400);
      try {
        return Response.json(await this.service.transcribe(audio, mediaType, active.signal));
      } catch (error) {
        return transcriptionErrorResponse(error);
      }
    } finally {
      request.signal.removeEventListener('abort', abort);
      if (this.active === active) this.active = undefined;
    }
  }

  public close(): void {
    this.active?.abort();
  }
}
