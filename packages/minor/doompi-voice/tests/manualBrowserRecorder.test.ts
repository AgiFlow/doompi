import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MANUAL_TRANSCRIPTION_DURATION_HEADER,
  MANUAL_TRANSCRIPTION_MAX_AUDIO_BYTES,
  MANUAL_TRANSCRIPTION_MAX_DURATION_MS,
  MANUAL_TRANSCRIPTION_ROUTE,
} from '../src/types/manualTranscription.ts';
import {
  startManualBrowserRecording,
  type ManualBrowserRecording,
  type ManualBrowserRecordingResult,
} from '../web/manualBrowserRecorder.ts';
import { ManualComposerRecorder } from '../web/manualComposerRecorder.ts';
import { transcribeManualRecording } from '../web/manualTranscriptionClient.ts';

function recorderFixture() {
  const stopTrack = vi.fn();
  let autoStop: (() => void) | undefined;
  const recorder = {
    mimeType: 'audio/webm;codecs=opus',
    state: 'inactive' as 'inactive' | 'recording' | 'paused',
    ondataavailable: null as ((event: { data: Blob }) => void) | null,
    onerror: null as ((event: { error?: Error }) => void) | null,
    onstop: null as (() => void) | null,
    start: vi.fn(() => {
      recorder.state = 'recording';
    }),
    stop: vi.fn(() => {
      recorder.ondataavailable?.({ data: new Blob(['first']) });
      recorder.ondataavailable?.({ data: new Blob(['second']) });
      recorder.state = 'inactive';
      recorder.onstop?.();
    }),
  };
  const dependencies = {
    getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })),
    createRecorder: vi.fn(() => recorder),
    isTypeSupported: vi.fn((type: string) => type === 'audio/webm'),
    setTimer: vi.fn((callback: () => void, delay: number) => {
      expect(delay).toBe(MANUAL_TRANSCRIPTION_MAX_DURATION_MS);
      autoStop = callback;
      return setTimeout(() => undefined, 60_000);
    }),
    clearTimer: vi.fn((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)),
    now: vi.fn().mockReturnValueOnce(100).mockReturnValue(225),
  };
  return { dependencies, recorder, stopTrack, autoStop: () => autoStop?.() };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.unstubAllGlobals());

describe('manual composer recorder', () => {
  it('stops on the second click, transcribes once, and appends the result', async () => {
    const result = deferred<ManualBrowserRecordingResult | undefined>();
    const recording: ManualBrowserRecording = { result: result.promise, stop: vi.fn(), cancel: vi.fn() };
    const append = vi.fn();
    const transcribe = vi.fn(async () => 'dictated text');
    const controller = new ManualComposerRecorder(append, vi.fn(), {
      start: async () => recording,
      transcribe,
    });

    await controller.toggle('session-1');
    expect(controller.snapshot().phase).toBe('recording');
    await controller.toggle('session-1');
    expect(recording.stop).toHaveBeenCalledOnce();
    expect(controller.snapshot().phase).toBe('transcribing');
    result.resolve({ audio: new Blob(['voice'], { type: 'audio/webm' }), durationMs: 125 });
    await vi.waitFor(() => expect(append).toHaveBeenCalledWith('dictated text'));

    expect(transcribe).toHaveBeenCalledWith(expect.any(Blob), 'session-1', 125, expect.any(AbortSignal));
    expect(controller.snapshot()).toEqual({ phase: 'idle' });
  });

  it('keeps an in-flight result bound to the session append that started it', async () => {
    const result = deferred<ManualBrowserRecordingResult | undefined>();
    const recording: ManualBrowserRecording = { result: result.promise, stop: vi.fn(), cancel: vi.fn() };
    const firstAppend = vi.fn();
    const secondAppend = vi.fn();
    const controller = new ManualComposerRecorder(firstAppend, vi.fn(), {
      start: async () => recording,
      transcribe: async () => 'dictated text',
    });

    await controller.toggle('session-1');
    controller.setAppend(secondAppend);
    await controller.toggle('session-1');
    result.resolve({ audio: new Blob(['voice'], { type: 'audio/webm' }), durationMs: 125 });
    await vi.waitFor(() => expect(firstAppend).toHaveBeenCalledWith('dictated text'));

    expect(secondAppend).not.toHaveBeenCalled();
  });

  it('aborts transcription and publishes nothing when disposed', async () => {
    const result = deferred<ManualBrowserRecordingResult | undefined>();
    const changed = vi.fn();
    const append = vi.fn();
    let signal: AbortSignal | undefined;
    const controller = new ManualComposerRecorder(append, changed, {
      start: async () => ({ result: result.promise, stop: vi.fn(), cancel: vi.fn() }),
      transcribe: async (_audio, _sessionId, _durationMs, transcriptionSignal) => {
        signal = transcriptionSignal;
        return await new Promise<string>((_resolve, reject) => {
          transcriptionSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    });

    await controller.toggle('session-1');
    result.resolve({ audio: new Blob(['voice'], { type: 'audio/webm' }), durationMs: 125 });
    await vi.waitFor(() => expect(signal).toBeDefined());
    changed.mockClear();
    controller.dispose();

    expect(signal?.aborted).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(controller.snapshot()).toEqual({ phase: 'idle' }));
    expect(append).not.toHaveBeenCalled();
  });

  it('cancels late work on reset and reports startup and transcription failures', async () => {
    const pendingStart = deferred<ManualBrowserRecording>();
    const lateRecording: ManualBrowserRecording = {
      result: Promise.resolve(undefined),
      stop: vi.fn(),
      cancel: vi.fn(),
    };
    const controller = new ManualComposerRecorder(vi.fn(), vi.fn(), {
      start: async () => await pendingStart.promise,
      transcribe: async () => 'unused',
    });
    const starting = controller.toggle('session-1');
    controller.reset();
    pendingStart.resolve(lateRecording);
    await starting;
    expect(lateRecording.cancel).toHaveBeenCalledOnce();
    await controller.toggle(null);
    expect(controller.snapshot()).toEqual({ phase: 'idle' });

    const startupError = new ManualComposerRecorder(vi.fn(), vi.fn(), {
      start: async () => {
        throw new Error('permission denied');
      },
      transcribe: async () => 'unused',
    });
    await startupError.toggle('session-1');
    expect(startupError.snapshot()).toEqual({ phase: 'idle', error: 'permission denied' });

    const audioResult = deferred<ManualBrowserRecordingResult | undefined>();
    const transcriptionError = new ManualComposerRecorder(vi.fn(), vi.fn(), {
      start: async () => ({ result: audioResult.promise, stop: vi.fn(), cancel: vi.fn() }),
      transcribe: async () => {
        throw new Error('transcription failed');
      },
    });
    await transcriptionError.toggle('session-1');
    audioResult.resolve({ audio: new Blob(['voice']), durationMs: 125 });
    await vi.waitFor(() => expect(transcriptionError.snapshot().error).toBe('transcription failed'));

    const unknownStartupError = new ManualComposerRecorder(vi.fn(), vi.fn(), {
      start: async () => Promise.reject('blocked'),
      transcribe: async () => 'unused',
    });
    await unknownStartupError.toggle('session-1');
    expect(unknownStartupError.snapshot().error).toBe('Voice recording failed.');

    const unknownAudioResult = deferred<ManualBrowserRecordingResult | undefined>();
    const unknownTranscriptionError = new ManualComposerRecorder(vi.fn(), vi.fn(), {
      start: async () => ({ result: unknownAudioResult.promise, stop: vi.fn(), cancel: vi.fn() }),
      transcribe: async () => Promise.reject('failed'),
    });
    await unknownTranscriptionError.toggle('session-1');
    unknownAudioResult.resolve({ audio: new Blob(['voice']), durationMs: 125 });
    await vi.waitFor(() => expect(unknownTranscriptionError.snapshot().error).toBe('Voice recording failed.'));
  });
});

describe('manual browser recording', () => {
  it('collects one Blob and releases every track when explicitly stopped', async () => {
    const fixture = recorderFixture();
    const recording = await startManualBrowserRecording(fixture.dependencies);

    recording.stop();
    const audio = await recording.result;

    expect(fixture.recorder.stop).toHaveBeenCalledOnce();
    expect(fixture.stopTrack).toHaveBeenCalledOnce();
    expect(audio?.audio.type).toBe('audio/webm;codecs=opus');
    expect(audio?.durationMs).toBe(125);
    await expect(audio?.audio.text()).resolves.toBe('firstsecond');
  });

  it('stops and rejects before retained chunks exceed the upload limit', async () => {
    const fixture = recorderFixture();
    const recording = await startManualBrowserRecording(fixture.dependencies);

    fixture.recorder.ondataavailable?.({
      data: new Blob([new Uint8Array(MANUAL_TRANSCRIPTION_MAX_AUDIO_BYTES + 1)]),
    });

    await expect(recording.result).rejects.toThrow('exceeds the 4 MiB');
    expect(fixture.recorder.stop).toHaveBeenCalledOnce();
    expect(fixture.stopTrack).toHaveBeenCalledOnce();
  });

  it('automatically stops after the manual recording duration limit', async () => {
    const fixture = recorderFixture();
    await startManualBrowserRecording(fixture.dependencies);

    fixture.autoStop();

    expect(fixture.recorder.stop).toHaveBeenCalledOnce();
    expect(fixture.stopTrack).toHaveBeenCalledOnce();
  });

  it('cancels without returning audio and lets Safari choose its native fallback format', async () => {
    const fixture = recorderFixture();
    const recording = await startManualBrowserRecording(fixture.dependencies);

    recording.cancel();

    await expect(recording.result).resolves.toBeUndefined();
    expect(fixture.stopTrack).toHaveBeenCalledOnce();

    const fallback = recorderFixture();
    await startManualBrowserRecording({ ...fallback.dependencies, isTypeSupported: () => false });
    expect(fallback.dependencies.createRecorder).toHaveBeenCalledWith(expect.anything(), undefined);
  });

  it('releases the microphone when recorder construction fails', async () => {
    const fixture = recorderFixture();

    await expect(
      startManualBrowserRecording({
        ...fixture.dependencies,
        createRecorder: () => {
          throw new Error('construction failed');
        },
      }),
    ).rejects.toThrow('construction failed');
    expect(fixture.stopTrack).toHaveBeenCalledOnce();
  });

  it('surfaces recorder errors and start failures while cleaning up tracks', async () => {
    const failed = recorderFixture();
    const recording = await startManualBrowserRecording(failed.dependencies);
    failed.recorder.onerror?.({});

    await expect(recording.result).rejects.toThrow('Browser audio recording failed');
    expect(failed.stopTrack).toHaveBeenCalledOnce();

    const startFailure = recorderFixture();
    startFailure.recorder.start.mockImplementation(() => {
      throw new Error('start failed');
    });
    await expect(startManualBrowserRecording(startFailure.dependencies)).rejects.toThrow('start failed');
    expect(startFailure.stopTrack).toHaveBeenCalledOnce();
  });

  it('uses the browser MediaRecorder dependencies by default', async () => {
    const fixture = recorderFixture();
    class BrowserRecorder {
      public static isTypeSupported(type: string): boolean {
        return type === 'audio/mp4';
      }

      public readonly mimeType = 'audio/mp4;codecs=mp4a.40.2';
      public state = fixture.recorder.state;
      public ondataavailable = fixture.recorder.ondataavailable;
      public onerror = fixture.recorder.onerror;
      public onstop = fixture.recorder.onstop;
      public start(): void {
        this.state = 'recording';
      }
      public stop(): void {
        this.state = 'inactive';
        this.onstop?.();
      }
    }
    vi.stubGlobal('MediaRecorder', BrowserRecorder);
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: async () => await fixture.dependencies.getUserMedia() },
    });

    const recording = await startManualBrowserRecording();
    recording.cancel();

    await expect(recording.result).resolves.toBeUndefined();
    expect(fixture.stopTrack).toHaveBeenCalledOnce();
  });
});

describe('manual transcription client', () => {
  it('posts the complete Blob once through the supplied sealed request and returns its transcript', async () => {
    const audio = new Blob(['voice'], { type: 'audio/webm' });
    const request = vi.fn(async () => Response.json({ transcript: 'dictated text' }));
    const controller = new AbortController();

    await expect(transcribeManualRecording(audio, 'session-1', 125, request, controller.signal)).resolves.toBe(
      'dictated text',
    );

    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(`/api/plugin/voice-media${MANUAL_TRANSCRIPTION_ROUTE}?session=session-1`, {
      method: 'POST',
      headers: {
        'content-type': 'audio/webm',
        [MANUAL_TRANSCRIPTION_DURATION_HEADER]: '125',
      },
      body: audio,
      signal: controller.signal,
    });
  });

  it('rejects oversized audio and malformed or failed responses', async () => {
    const request = vi.fn(async () => Response.json({ transcript: 'unused' }));
    const oversized = new Blob([new Uint8Array(MANUAL_TRANSCRIPTION_MAX_AUDIO_BYTES + 1)], { type: 'audio/webm' });

    await expect(transcribeManualRecording(oversized, 'session-1', 125, request)).rejects.toThrow('exceeds the 4 MiB');
    expect(request).not.toHaveBeenCalled();
    await expect(transcribeManualRecording(new Blob(), 'session-1', 0, request)).rejects.toThrow('empty');
    await expect(
      transcribeManualRecording(new Blob(['voice'], { type: 'audio/webm' }), 'session-1', 300_001, request),
    ).rejects.toThrow('duration');
    expect(request).not.toHaveBeenCalled();
    await expect(
      transcribeManualRecording(new Blob(['voice'], { type: 'audio/mp4' }), 'session-1', 125, async () =>
        Response.json({ error: 'transcriber unavailable' }, { status: 503 }),
      ),
    ).rejects.toThrow('transcriber unavailable');
    await expect(
      transcribeManualRecording(new Blob(['voice'], { type: 'audio/webm' }), 'session-1', 125, async () =>
        Response.json({ nope: true }),
      ),
    ).rejects.toThrow('invalid response');
  });

  it('uses status errors when a failed response has no usable JSON body', async () => {
    const audio = new Blob(['voice'], { type: 'audio/webm' });

    await expect(
      transcribeManualRecording(audio, 'session-1', 125, async () => new Response('not json', { status: 502 })),
    ).rejects.toThrow('status 502');
    await expect(
      transcribeManualRecording(audio, 'session-1', 125, async () => Response.json({ transcript: 42 })),
    ).rejects.toThrow('invalid response');
  });
});
