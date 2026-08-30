import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FfmpegEncodedAudioDecoder } from '../src/adapters/audio/encodedAudio.ts';
import { SystemClock } from '../src/adapters/audio/infrastructure.ts';
import {
  ManualTranscriptionApi,
  normalizeManualTranscriptionMediaType,
} from '../src/adapters/manualTranscriptionApi.ts';
import { createVoiceSessionApi } from '../src/adapters/voiceSessionApi.ts';
import { encodePcm16Wav } from '../src/services/pcm.ts';
import { ManualTranscriptionService } from '../src/services/manualTranscription.ts';
import type {
  IClock,
  IExecutableResolver,
  IProcessSpawner,
  ITemporaryWorkspace,
  ITranscriberAdapter,
  ITranscriberRegistry,
  ProcessResult,
  RunningProcess,
  TimerHandle,
  TranscriptionAdapterOutput,
} from '../src/types/index.ts';
import {
  MANUAL_TRANSCRIPTION_DURATION_HEADER,
  MANUAL_TRANSCRIPTION_MAX_AUDIO_BYTES,
  MANUAL_TRANSCRIPTION_MAX_TRANSCRIPT_BYTES,
  MANUAL_TRANSCRIPTION_ROUTE,
  MANUAL_TRANSCRIPTION_TIMEOUT_MS,
  type IManualTranscriptionService,
  ManualTranscriptionError,
} from '../src/types/manualTranscription.ts';
import type { ResolvedVoiceConfig, VoiceAdapterConfig } from '@agimon-ai/doompi-config';

const adapterConfig: VoiceAdapterConfig = { model: { id: 'test' } };
const voiceConfig: ResolvedVoiceConfig = {
  engine: 'mlx-whisper',
  language: 'en',
  recorder: { device: ':0' },
  adapters: { 'mlx-whisper': adapterConfig },
};

function webmAudio(size = 16): Buffer {
  const audio = Buffer.alloc(size);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(audio);
  return audio;
}

function request(body: Buffer, contentType = 'audio/webm; codecs=opus'): Request {
  return new Request(`http://voice.test${MANUAL_TRANSCRIPTION_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': contentType, [MANUAL_TRANSCRIPTION_DURATION_HEADER]: '125' },
    body,
  });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('manual transcription protocol and API', () => {
  it('normalizes supported MediaRecorder MIME values', () => {
    expect(normalizeManualTranscriptionMediaType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(normalizeManualTranscriptionMediaType('audio/mp4; codecs="mp4a.40.2"')).toBe('audio/mp4');
    expect(normalizeManualTranscriptionMediaType('audio/webm;codecs=vorbis')).toBeUndefined();
  });

  it('accepts one bounded blob and returns the transcript', async () => {
    const transcribe = vi.fn(async () => ({ transcript: 'hello' }));
    const api = new ManualTranscriptionApi({ transcribe });
    const response = await api.fetch(request(webmAudio()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ transcript: 'hello' });
    expect(transcribe).toHaveBeenCalledWith(webmAudio(), 'audio/webm', expect.any(AbortSignal));
  });

  it('rejects unsupported and oversized uploads before transcription', async () => {
    const transcribe = vi.fn(async () => ({ transcript: 'unused' }));
    const api = new ManualTranscriptionApi({ transcribe });
    expect((await api.fetch(request(webmAudio(), 'audio/ogg'))).status).toBe(415);
    expect((await api.fetch(request(webmAudio(MANUAL_TRANSCRIPTION_MAX_AUDIO_BYTES + 1)))).status).toBe(413);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('rejects empty bodies and other methods', async () => {
    const api = new ManualTranscriptionApi({ transcribe: async () => ({ transcript: 'unused' }) });
    expect((await api.fetch(request(Buffer.alloc(0)))).status).toBe(400);
    expect(
      (
        await api.fetch(
          new Request(`http://voice.test${MANUAL_TRANSCRIPTION_ROUTE}`, {
            headers: { 'content-type': 'audio/webm' },
          }),
        )
      ).status,
    ).toBe(405);
  });

  it('rejects a missing or excessive claimed duration before reading audio', async () => {
    const transcribe = vi.fn(async () => ({ transcript: 'unused' }));
    const api = new ManualTranscriptionApi({ transcribe });
    const missing = new Request(`http://voice.test${MANUAL_TRANSCRIPTION_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'audio/webm' },
      body: webmAudio(),
    });
    const excessive = request(webmAudio());
    excessive.headers.set(MANUAL_TRANSCRIPTION_DURATION_HEADER, '300001');

    expect((await api.fetch(missing)).status).toBe(400);
    expect((await api.fetch(excessive)).status).toBe(400);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it.each([
    [
      new ManualTranscriptionError('timeout', 'private timeout detail'),
      504,
      'timeout',
      'Voice transcription timed out.',
    ],
    [
      new ManualTranscriptionError('unavailable', 'private config path'),
      503,
      'unavailable',
      'Voice transcription is not configured.',
    ],
    [
      new ManualTranscriptionError('empty_transcript', 'private output'),
      422,
      'empty_transcript',
      'Voice transcription was empty.',
    ],
    [
      new ManualTranscriptionError('invalid_audio', 'private decoder detail'),
      400,
      'invalid_audio',
      'Audio recording is invalid.',
    ],
    [
      new ManualTranscriptionError('output_too_large', 'private output'),
      502,
      'output_too_large',
      'Voice transcription output is too large.',
    ],
    [
      new Error('adapter failed at /private/workspace with token=secret'),
      500,
      'transcription_failed',
      'Voice transcription failed.',
    ],
  ])('maps service failures without exposing internal details', async (error, status, code, publicMessage) => {
    const api = new ManualTranscriptionApi({
      transcribe: async () => {
        throw error;
      },
    });
    const response = await api.fetch(request(webmAudio()));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code, error: publicMessage });
  });

  it('rejects a parallel request while one transcription is active', async () => {
    const pending = deferred<{ transcript: string }>();
    const transcribe = vi.fn(async () => await pending.promise);
    const api = new ManualTranscriptionApi({ transcribe });

    const first = api.fetch(request(webmAudio()));
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
    const parallel = await api.fetch(request(webmAudio()));
    expect(parallel.status).toBe(409);
    expect(await parallel.json()).toEqual({
      code: 'transcription_busy',
      error: 'Voice transcription is already in progress.',
    });

    pending.resolve({ transcript: 'complete' });
    expect(await (await first).json()).toEqual({ transcript: 'complete' });
    expect((await api.fetch(request(webmAudio()))).status).toBe(200);
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it('aborts the active service request when the session API closes', async () => {
    let signal: AbortSignal | undefined;
    const api = new ManualTranscriptionApi({
      transcribe: async (_audio, _mediaType, activeSignal) => {
        signal = activeSignal;
        return await new Promise((_resolve, reject) => {
          activeSignal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      },
    });

    const pending = api.fetch(request(webmAudio()));
    await vi.waitFor(() => expect(signal).toBeDefined());
    api.close();
    const response = await pending;

    expect(signal?.aborted).toBe(true);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: 'transcription_failed', error: 'Voice transcription failed.' });
  });

  it('composes the manual route without changing existing route delegation', async () => {
    const manualTranscription: IManualTranscriptionService = { transcribe: async () => ({ transcript: 'composite' }) };
    const api = createVoiceSessionApi({ manualTranscription, clientConnectWaitMs: 0 });
    const manual = await api.fetch(request(webmAudio()));
    expect(await manual.json()).toEqual({ transcript: 'composite' });
    const existing = await api.fetch(new Request('http://voice.test/client/connect', { method: 'POST', body: '{}' }));
    expect(existing.status).toBe(400);
    api.close();
  });
});

describe('encoded audio decoder', () => {
  it('validates the container and invokes FFmpeg with private fixed-format output', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-decoder-test-'));
    const run = vi.fn(async (_executable: string, args: readonly string[]): Promise<ProcessResult> => {
      fs.writeFileSync(args.at(-1)!, encodePcm16Wav(Buffer.alloc(320)));
      return { code: 0, stdout: '', stderr: '' };
    });
    const resolver: IExecutableResolver = { resolve: () => '/usr/bin/ffmpeg' };
    const spawner: IProcessSpawner = {
      run,
      start: (): RunningProcess => {
        throw new Error('unused');
      },
    };
    try {
      const output = await new FfmpegEncodedAudioDecoder(resolver, spawner).decode(
        webmAudio(),
        'audio/webm',
        workspace,
      );
      expect(output).toBe(path.join(workspace, 'recording.wav'));
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]![1]).toContain('pcm_s16le');
      expect(fs.statSync(output).mode & 0o777).toBe(0o600);
      await expect(
        new FfmpegEncodedAudioDecoder(resolver, spawner).decode(Buffer.from('not webm'), 'audio/webm', workspace),
      ).rejects.toThrow('container');
      expect(run).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('manual transcription service', () => {
  it('selects one adapter and always cleans its workspace', async () => {
    const transcribe = vi.fn(async () => ({ transcript: '  decoded text  ' }));
    const adapter: ITranscriberAdapter = {
      engine: 'mlx-whisper',
      preflight: () => undefined,
      transcribe,
    };
    const select = vi.fn(() => ({ adapter, config: adapterConfig }));
    const registry: ITranscriberRegistry = { select };
    const remove = vi.fn();
    const workspaces: ITemporaryWorkspace = {
      create: () => '/private/workspace',
      writeFile: () => '/private/workspace/input',
      remove,
    };
    const decode = vi.fn(async () => '/private/workspace/recording.wav');
    const service = new ManualTranscriptionService(
      { load: () => voiceConfig },
      { decode },
      registry,
      workspaces,
      new SystemClock(),
    );

    await expect(service.transcribe(webmAudio(), 'audio/webm')).resolves.toEqual({ transcript: 'decoded text' });
    expect(select).toHaveBeenCalledOnce();
    expect(transcribe).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('/private/workspace');

    decode.mockRejectedValueOnce(new Error('decode failed'));
    await expect(service.transcribe(webmAudio(), 'audio/webm')).rejects.toThrow('decode failed');
    expect(remove).toHaveBeenCalledTimes(2);

    transcribe.mockResolvedValueOnce({ transcript: '   ' });
    await expect(service.transcribe(webmAudio(), 'audio/webm')).rejects.toThrow('transcription was empty');
    transcribe.mockResolvedValueOnce({ transcript: 'x'.repeat(MANUAL_TRANSCRIPTION_MAX_TRANSCRIPT_BYTES + 1) });
    await expect(service.transcribe(webmAudio(), 'audio/webm')).rejects.toThrow('output exceeded');
    expect(remove).toHaveBeenCalledTimes(4);
  });

  it('aborts the adapter and defers cleanup when the caller cancels', async () => {
    const pending = deferred<TranscriptionAdapterOutput>();
    let signal: AbortSignal | undefined;
    const adapter: ITranscriberAdapter = {
      engine: 'mlx-whisper',
      preflight: () => undefined,
      transcribe: async (request) => {
        signal = request.signal;
        return await pending.promise;
      },
    };
    const remove = vi.fn();
    const service = new ManualTranscriptionService(
      { load: () => voiceConfig },
      { decode: async () => '/private/workspace/recording.wav' },
      { select: () => ({ adapter, config: adapterConfig }) },
      {
        create: () => '/private/workspace',
        writeFile: () => '/private/workspace/input',
        remove,
      },
      new SystemClock(),
    );
    const controller = new AbortController();

    const result = service.transcribe(webmAudio(), 'audio/webm', controller.signal);
    const cancelled = expect(result).rejects.toThrow('Voice transcription was cancelled.');
    await vi.waitFor(() => expect(signal).toBeDefined());
    controller.abort();
    await cancelled;

    expect(signal?.aborted).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    pending.reject(new Error('adapter stopped'));
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith('/private/workspace'));
  });

  it('returns a timeout before deferring workspace cleanup until the aborted adapter settles', async () => {
    const pending = deferred<TranscriptionAdapterOutput>();
    let timeoutCallback = (): void => undefined;
    let signal: AbortSignal | undefined;
    const clear = vi.fn();
    const clock: IClock = {
      now: () => 0,
      setInterval: () => ({}) as TimerHandle,
      setTimeout: (callback, milliseconds) => {
        expect(milliseconds).toBe(MANUAL_TRANSCRIPTION_TIMEOUT_MS);
        timeoutCallback = callback;
        return {} as TimerHandle;
      },
      clear,
    };
    const adapter: ITranscriberAdapter = {
      engine: 'mlx-whisper',
      preflight: () => undefined,
      transcribe: async (request) => {
        signal = request.signal;
        return await pending.promise;
      },
    };
    const remove = vi.fn();
    const service = new ManualTranscriptionService(
      { load: () => voiceConfig },
      { decode: async () => '/private/workspace/recording.wav' },
      { select: () => ({ adapter, config: adapterConfig }) },
      {
        create: () => '/private/workspace',
        writeFile: () => '/private/workspace/input',
        remove,
      },
      clock,
    );

    const result = service.transcribe(webmAudio(), 'audio/webm');
    const timedOut = expect(result).rejects.toThrow('Voice transcription timed out.');
    await vi.waitFor(() => expect(signal).toBeDefined());
    timeoutCallback();
    await timedOut;

    expect(signal?.aborted).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    pending.reject(new Error('adapter stopped'));
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith('/private/workspace'));
    expect(clear).toHaveBeenCalledOnce();
  });
});
