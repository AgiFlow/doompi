import fs from 'node:fs';
import path from 'node:path';
import type { IExecutableResolver, IProcessSpawner } from '../../types/index.ts';
import {
  MANUAL_TRANSCRIPTION_DECODE_TIMEOUT_MS,
  MANUAL_TRANSCRIPTION_MAX_DURATION_MS,
  type IEncodedAudioDecoder,
  ManualTranscriptionError,
  type ManualTranscriptionMediaType,
} from '../../types/manualTranscription.ts';

const FFMPEG_BINARY = 'ffmpeg';
const INPUT_FILE_NAMES: Record<ManualTranscriptionMediaType, string> = {
  'audio/webm': 'recording.webm',
  'audio/mp4': 'recording.mp4',
};
const OUTPUT_FILE_NAME = 'recording.wav';
const PCM_BYTES_PER_SECOND = 16_000 * 2;
const WEBM_SIGNATURE = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

function validateSignature(audio: Buffer, mediaType: ManualTranscriptionMediaType): void {
  const webm = audio.length >= 4 && audio.subarray(0, 4).equals(WEBM_SIGNATURE);
  const mp4 = audio.length >= 12 && audio.toString('ascii', 4, 8) === 'ftyp';
  if ((mediaType === 'audio/webm' && !webm) || (mediaType === 'audio/mp4' && !mp4))
    throw new ManualTranscriptionError('invalid_audio', 'Audio container does not match its media type.');
}

function pcmDataBytes(wav: Buffer): number {
  if (wav.length < 12 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE')
    throw new ManualTranscriptionError('invalid_audio', 'FFmpeg did not produce a WAV file.');
  let offset = 12;
  let validFormat = false;
  let dataBytes: number | undefined;
  while (offset + 8 <= wav.length) {
    const chunk = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > wav.length) throw new ManualTranscriptionError('invalid_audio', 'WAV chunk is truncated.');
    if (chunk === 'fmt ' && size >= 16) {
      validFormat =
        wav.readUInt16LE(start) === 1 &&
        wav.readUInt16LE(start + 2) === 1 &&
        wav.readUInt32LE(start + 4) === 16_000 &&
        wav.readUInt32LE(start + 8) === PCM_BYTES_PER_SECOND &&
        wav.readUInt16LE(start + 12) === 2 &&
        wav.readUInt16LE(start + 14) === 16;
    }
    if (chunk === 'data') dataBytes = size;
    offset = start + size + (size % 2);
  }
  if (!validFormat || dataBytes === undefined)
    throw new ManualTranscriptionError('invalid_audio', 'FFmpeg did not produce mono 16 kHz PCM16 audio.');
  return dataBytes;
}

export class FfmpegEncodedAudioDecoder implements IEncodedAudioDecoder {
  public constructor(
    private readonly executables: IExecutableResolver,
    private readonly spawner: IProcessSpawner,
  ) {}

  public async decode(
    audio: Buffer,
    mediaType: ManualTranscriptionMediaType,
    workspace: string,
    configuredBinary?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    validateSignature(audio, mediaType);
    const inputPath = path.join(workspace, INPUT_FILE_NAMES[mediaType]);
    const outputPath = path.join(workspace, OUTPUT_FILE_NAME);
    fs.writeFileSync(inputPath, audio, { mode: 0o600 });
    const controller = new AbortController();
    let timedOut = false;
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, MANUAL_TRANSCRIPTION_DECODE_TIMEOUT_MS);
    try {
      let executable: string;
      try {
        executable = this.executables.resolve(configuredBinary, FFMPEG_BINARY);
      } catch (error) {
        throw new ManualTranscriptionError(
          'unavailable',
          error instanceof Error ? error.message : 'FFmpeg is unavailable.',
        );
      }
      const result = await this.spawner.run(
        executable,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-i',
          inputPath,
          '-t',
          String(MANUAL_TRANSCRIPTION_MAX_DURATION_MS / 1_000 + 0.001),
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          '-f',
          'wav',
          '-y',
          outputPath,
        ],
        { signal: controller.signal },
      );
      if (timedOut) throw new ManualTranscriptionError('timeout', 'Audio decoding timed out.');
      if (signal?.aborted) throw new Error('Voice transcription was cancelled.');
      if (result.code !== 0)
        throw new ManualTranscriptionError('invalid_audio', 'FFmpeg could not decode the audio recording.');
      fs.chmodSync(outputPath, 0o600);
      const decodedBytes = pcmDataBytes(fs.readFileSync(outputPath));
      if (decodedBytes > (MANUAL_TRANSCRIPTION_MAX_DURATION_MS / 1_000) * PCM_BYTES_PER_SECOND)
        throw new ManualTranscriptionError('invalid_audio', 'Audio duration exceeds 300 seconds.');
      return outputPath;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}
