import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserVoiceMediaDevice, Pcm16Resampler } from '../src/web/browserMediaDevice.ts';
class FakeNode {
  public connect(): void {}
  public disconnect(): void {}
}

class FakeScriptProcessor extends FakeNode {
  public onaudioprocess:
    | ((event: { inputBuffer: { getChannelData(channel: number): Float32Array }; playbackTime?: number }) => void)
    | null = null;
}

class FakeBufferSource extends FakeNode {
  public buffer: unknown;
  public onended: (() => void) | null = null;
  public start = vi.fn();
  public stop = vi.fn(() => this.onended?.());
}
class FakeAudioContext {
  public readonly sampleRate = 16_000;
  public readonly destination = new FakeNode();
  public readonly processor = new FakeScriptProcessor();
  public readonly bufferSource = new FakeBufferSource();
  public readonly copiedSamples: Float32Array[] = [];
  public currentTime = 0;
  public state: 'running' | 'suspended' | 'closed' = 'running';

  public async resume(): Promise<void> {}
  public createMediaStreamSource(): FakeNode {
    return new FakeNode();
  }
  public createGain(): FakeNode & { gain: { value: number } } {
    return Object.assign(new FakeNode(), { gain: { value: 0 } });
  }
  public createScriptProcessor(): FakeScriptProcessor {
    return this.processor;
  }
  public createBuffer(
    _channels: number,
    length: number,
  ): {
    copyToChannel: (samples: Float32Array) => void;
    getChannelData: () => Float32Array;
  } {
    const channel = new Float32Array(length);
    return {
      copyToChannel: (samples) => {
        channel.set(samples);
        this.copiedSamples.push(channel);
      },
      getChannelData: () => channel,
    };
  }
  public createBufferSource(): FakeBufferSource {
    return this.bufferSource;
  }
  public async close(): Promise<void> {
    this.state = 'closed';
  }
}

class FakeSpeechUtterance {
  public rate = 1;
  public volume = 1;
  public voice: SpeechSynthesisVoice | null = null;
  public onstart: (() => void) | null = null;
  public onend: (() => void) | null = null;
  public onerror: ((event: { error: string }) => void) | null = null;

  public constructor(public readonly text: string) {}
}
class PendingWorker {
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: { message?: string }) => void) | null = null;
  public readonly postMessage = vi.fn();
  public readonly terminate = vi.fn();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('browser media device recovery guards', () => {
  it('validates resampling rates and clips both PCM extremes', () => {
    expect(() => new Pcm16Resampler(0)).toThrow('positive');
    expect(() => new Pcm16Resampler(Number.NaN)).toThrow('positive');
    const bytes = new Pcm16Resampler(16_000).push(new Float32Array([-2, 2]));
    const view = new DataView(bytes.buffer);
    expect([view.getInt16(0, true), view.getInt16(2, true)]).toEqual([-32_768, 32_767]);
    expect(new Pcm16Resampler(32_000).push(new Float32Array([0, 0]))).toHaveLength(2);
  });

  it('advertises iPhone playback when speech synthesis exists before the utterance constructor', () => {
    const synthesis = { speak: vi.fn() };
    vi.stubGlobal('window', { speechSynthesis: synthesis });
    vi.stubGlobal('SpeechSynthesisUtterance', undefined);

    const device = new BrowserVoiceMediaDevice();

    expect(device.capabilities.playback).toBe(true);
    expect(device.capabilities.playbackDucking).toBe(true);
  });
  it('skips optional detector preparation when browser prerequisites are absent', async () => {
    vi.stubGlobal('Worker', undefined);
    await expect(new BrowserVoiceMediaDevice().prepare()).resolves.toBeUndefined();
    vi.stubGlobal('Worker', class {});
    vi.stubGlobal('WebAssembly', undefined);
    await expect(new BrowserVoiceMediaDevice().prepare()).resolves.toBeUndefined();
  });
  it('keeps speech capabilities disabled when the Worker constructor throws', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        public constructor() {
          throw new Error('worker unavailable');
        }
      },
    );
    vi.stubGlobal('WebAssembly', WebAssembly);

    const device = new BrowserVoiceMediaDevice();
    await expect(device.prepare()).resolves.toBeUndefined();
    expect(device.capabilities.captureActivity).toBe(false);
    expect(device.capabilities.autonomousOrchestration).toBe(false);
    expect(device.createSpeechPresenceDetector()).toBeUndefined();
  });

  it('terminates pending detector initialization without restoring capabilities after close', async () => {
    class TestWorker extends PendingWorker {
      public static instance: TestWorker | undefined;

      public constructor() {
        super();
        TestWorker.instance = this;
      }
    }
    vi.stubGlobal('Worker', TestWorker);
    vi.stubGlobal('WebAssembly', WebAssembly);
    const device = new BrowserVoiceMediaDevice(true);

    const preparation = device.prepare();
    await Promise.resolve();
    const worker = TestWorker.instance;
    const lateReply = worker?.onmessage;
    expect(worker?.postMessage).toHaveBeenCalledOnce();

    await device.close();
    await expect(preparation).resolves.toBeUndefined();
    expect(worker?.terminate).toHaveBeenCalledOnce();
    lateReply?.({ data: { id: 1, result: true } });
    await Promise.resolve();
    expect(device.capabilities.captureActivity).toBe(false);
    expect(device.capabilities.autonomousOrchestration).toBe(false);
    expect(device.createSpeechPresenceDetector()).toBeUndefined();
  });

  it('unlocks mobile Web Audio during the tap before remote capture starts', async () => {
    const listeners = new Map<string, EventListener>();
    const addEventListener = vi.fn((type: string, listener: EventListener) => listeners.set(type, listener));
    const removeEventListener = vi.fn((type: string) => listeners.delete(type));
    const contexts: FakeAudioContext[] = [];
    class SuspendedAudioContext extends FakeAudioContext {
      public constructor() {
        super();
        this.state = 'suspended';
        contexts.push(this);
      }

      public override async resume(): Promise<void> {
        this.state = 'running';
      }
    }
    vi.stubGlobal('window', { addEventListener, removeEventListener });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } });
    vi.stubGlobal('AudioContext', SuspendedAudioContext);
    vi.stubGlobal('Worker', undefined);
    const device = new BrowserVoiceMediaDevice();

    device.armUserGesture();
    expect(contexts).toHaveLength(0);
    listeners.get('pointerdown')?.({} as Event);
    await Promise.resolve();

    expect(contexts[0]?.state).toBe('running');
    expect(removeEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    await device.close();
    expect(contexts[0]?.state).toBe('closed');
  });
  it('primes mobile speech synthesis during a user tap before narration arrives', async () => {
    const listeners = new Map<string, EventListener>();
    const synthesis = {
      cancel: vi.fn(),
      getVoices: vi.fn(() => []),
      pending: false,
      resume: vi.fn(),
      speak: vi.fn(),
      speaking: false,
    };
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
      speechSynthesis: synthesis,
      SpeechSynthesisUtterance: FakeSpeechUtterance,
    });
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('SpeechSynthesisUtterance', FakeSpeechUtterance);
    vi.stubGlobal('Worker', undefined);
    const device = new BrowserVoiceMediaDevice();

    await device.prepare();
    listeners.get('pointerdown')?.({} as Event);

    expect(synthesis.resume).toHaveBeenCalledOnce();
    expect(synthesis.speak).toHaveBeenCalledOnce();
    const warmup = synthesis.speak.mock.calls[0]?.[0] as FakeSpeechUtterance;
    expect(warmup).toMatchObject({ text: 'a', volume: 0.01, rate: 10 });
    const playback = device.speak({
      sequence: 1,
      type: 'playback-start',
      playbackId: 'queued-playback',
      text: 'Narration follows the gesture-authorized warmup.',
    });
    expect(synthesis.cancel).not.toHaveBeenCalled();
    expect(synthesis.speak).toHaveBeenCalledTimes(2);
    const narration = synthesis.speak.mock.calls[1]?.[0] as FakeSpeechUtterance;
    narration.onstart?.();
    narration.onend?.();
    await expect(playback.completion).resolves.toMatchObject({ outcome: 'completed' });
    await device.close();
  });

  it('fails silent browser narration instead of remaining stuck in narrating', async () => {
    vi.useFakeTimers();
    const synthesis = {
      cancel: vi.fn(),
      getVoices: vi.fn(() => []),
      pending: false,
      resume: vi.fn(),
      speak: vi.fn(),
      speaking: false,
    };
    vi.stubGlobal('window', { speechSynthesis: synthesis, SpeechSynthesisUtterance: FakeSpeechUtterance });
    vi.stubGlobal('SpeechSynthesisUtterance', FakeSpeechUtterance);
    const device = new BrowserVoiceMediaDevice();
    const playback = device.speak({
      sequence: 1,
      type: 'playback-start',
      playbackId: 'stalled-playback',
      text: 'This narration never starts.',
    });

    await vi.advanceTimersByTimeAsync(5_000);

    await expect(playback.completion).resolves.toEqual({
      playbackId: 'stalled-playback',
      outcome: 'failed',
      error: 'Browser speech synthesis did not start.',
    });
    expect(synthesis.cancel).toHaveBeenCalledOnce();
    await device.close();
  });

  it('plays streamed backend PCM through the gesture-resumed AudioContext', async () => {
    const contexts: FakeAudioContext[] = [];
    const listeners = new Map<string, EventListener>();
    class PlaybackAudioContext extends FakeAudioContext {
      public constructor() {
        super();
        contexts.push(this);
      }
    }
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    });
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('AudioContext', PlaybackAudioContext);
    vi.stubGlobal('Worker', undefined);
    const device = new BrowserVoiceMediaDevice();
    await device.prepare();
    listeners.get('pointerdown')?.({} as Event);
    await Promise.resolve();
    const playback = device.speak(
      {
        sequence: 1,
        type: 'playback-start',
        playbackId: 'streamed-playback',
        text: 'Backend audio.',
        delivery: 'streamed',
      },
      Promise.resolve(new Uint8Array([0, 0, 0xff, 0x7f])),
    );
    await vi.waitFor(() => expect(contexts[0]?.bufferSource.start).toHaveBeenCalledOnce());
    expect(Array.from(contexts[0]!.copiedSamples[0]!)).toEqual([0, 32_767 / 32_768]);
    contexts[0]!.bufferSource.onended?.();
    await expect(playback.completion).resolves.toEqual({ playbackId: 'streamed-playback', outcome: 'completed' });
    await device.close();
  });
  it('uses streamed playback PCM only for local echo-aware speech analysis', async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] };
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', undefined);
    vi.stubGlobal('Worker', undefined);
    const device = new BrowserVoiceMediaDevice();
    const rawUploads: Uint8Array[] = [];
    const analyses: Array<{ speechPcm: Uint8Array; echoReferenceActive: boolean; echoDiscriminated: boolean }> = [];
    const capture = await device.startCapture((pcm, analysis) => {
      rawUploads.push(pcm);
      if (analysis !== undefined) analyses.push(analysis);
    });
    const context = (device as unknown as { context: FakeAudioContext }).context;
    let random = 8;
    const reference = Float32Array.from({ length: 16_000 }, (_, index) => {
      random = (Math.imul(random, 1_664_525) + 1_013_904_223) >>> 0;
      return ((random / 0xffff_ffff) * 2 - 1) * (0.15 + 0.1 * Math.sin(index / 700));
    });
    const referencePcm = new Uint8Array(reference.length * 2);
    const referenceView = new DataView(referencePcm.buffer);
    reference.forEach((sample, index) => referenceView.setInt16(index * 2, Math.round(sample * 32_767), true));
    const playback = device.speak(
      {
        sequence: 1,
        type: 'playback-start',
        playbackId: 'echo-reference',
        text: 'Exact backend PCM.',
        delivery: 'streamed',
      },
      Promise.resolve(referencePcm),
    );
    await vi.waitFor(() => expect(context.bufferSource.start).toHaveBeenCalledOnce());

    for (let index = 0; index < 6; index += 1) {
      context.currentTime = index / 10;
      const input = reference.slice(index * 1_600, (index + 1) * 1_600);
      context.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => input }, playbackTime: index / 10 });
    }

    expect(rawUploads).toHaveLength(6);
    expect(rawUploads[5]).toEqual(new Pcm16Resampler(16_000).push(reference.slice(8_000, 9_600)));
    expect(analyses.slice(-3).every((analysis) => analysis.echoReferenceActive)).toBe(true);
    expect(analyses.slice(-3).some((analysis) => analysis.echoDiscriminated)).toBe(false);
    const residual = analyses.at(-1)?.speechPcm;
    expect(residual).toBeDefined();
    const residualView = new DataView(residual!.buffer, residual!.byteOffset, residual!.byteLength);
    expect(
      Math.max(
        ...Array.from({ length: residual!.byteLength / 2 }, (_, index) =>
          Math.abs(residualView.getInt16(index * 2, true)),
        ),
      ),
    ).toBeLessThanOrEqual(1);

    const discontinuousInputs = [
      reference.slice(9_600, 10_400),
      new Float32Array(800).fill(0.2),
      new Float32Array(1_600).fill(0.2),
      new Float32Array(1_600).fill(0.2),
      new Float32Array(1_600).fill(0.2),
    ];
    const discontinuousTimestamps = [0.6, 1, 1.05, 1.15, 1.25];
    for (const [index, input] of discontinuousInputs.entries())
      context.processor.onaudioprocess?.({
        inputBuffer: { getChannelData: () => input },
        playbackTime: discontinuousTimestamps[index],
      });

    const expectedDiscontinuousInput = new Float32Array(6_400);
    let expectedOffset = 0;
    for (const input of discontinuousInputs) {
      expectedDiscontinuousInput.set(input, expectedOffset);
      expectedOffset += input.length;
    }
    const expectedDiscontinuousPcm = new Pcm16Resampler(16_000).push(expectedDiscontinuousInput);
    expect(rawUploads).toHaveLength(10);
    for (let index = 0; index < 4; index += 1)
      expect(rawUploads[index + 6]).toEqual(expectedDiscontinuousPcm.slice(index * 3_200, (index + 1) * 3_200));
    expect(analyses.slice(6).every((analysis) => !analysis.echoDiscriminated)).toBe(true);
    expect(analyses.slice(6).every((analysis) => analysis.speechPcm.every((value) => value === 0))).toBe(true);
    await capture.stop();
    context.currentTime = 1.35;
    context.bufferSource.onended?.();
    await expect(playback.completion).resolves.toMatchObject({ outcome: 'completed' });
    await device.close();
  });

  it('emits exact 100 ms PCM batches and one final remainder for a large ScriptProcessor input', async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] };
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', undefined);
    const device = new BrowserVoiceMediaDevice();
    const uploads: Uint8Array[] = [];

    const capture = await device.startCapture((pcm) => uploads.push(pcm));
    await expect(device.startCapture(() => undefined)).rejects.toThrow('already active');
    const context = (device as unknown as { context: FakeAudioContext }).context;
    const input = Float32Array.from({ length: 8_192 }, (_, index) => (index % 2 === 0 ? 0.25 : -0.25));
    context.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => input } });

    expect(uploads.map((upload) => upload.byteLength)).toEqual([3_200, 3_200, 3_200, 3_200, 3_200]);
    await capture.stop();
    await capture.stop();
    expect(uploads.map((upload) => upload.byteLength)).toEqual([3_200, 3_200, 3_200, 3_200, 3_200, 384]);
    expect(track.stop).toHaveBeenCalledOnce();
    await device.startCapture(() => undefined);
    await device.close();
    expect(track.stop).toHaveBeenCalledTimes(2);
  });

  it('keeps one page-lifetime microphone stream across rebindable captures', async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] };
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', undefined);
    const device = new BrowserVoiceMediaDevice(true);

    const first = await device.startCapture(() => undefined);
    await first.stop();
    expect(track.stop).not.toHaveBeenCalled();
    const second = await device.startCapture(() => undefined);
    expect(getUserMedia).toHaveBeenCalledOnce();
    await second.stop();
    expect(track.stop).not.toHaveBeenCalled();

    await device.close();
    expect(track.stop).toHaveBeenCalledOnce();
  });
  it('rejects capture when microphone APIs are unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const device = new BrowserVoiceMediaDevice();
    await expect(device.startCapture(() => undefined)).rejects.toThrow('cannot capture');
    expect(() => device.speak({ sequence: 1, type: 'playback-start', playbackId: 'playback', text: 'hello' })).toThrow(
      'cannot play',
    );
    await expect(device.close()).resolves.toBeUndefined();
  });

  it('fades browser narration down, holds it, and restores it after a classifier cue', async () => {
    vi.useFakeTimers();
    let utterance: FakeSpeechUtterance | undefined;
    const synthesis = {
      cancel: vi.fn(),
      getVoices: vi.fn(() => []),
      pending: false,
      resume: vi.fn(),
      speak: vi.fn((value: FakeSpeechUtterance) => {
        utterance = value;
      }),
      speaking: false,
    };
    vi.stubGlobal('window', { speechSynthesis: synthesis, SpeechSynthesisUtterance: FakeSpeechUtterance });
    vi.stubGlobal('SpeechSynthesisUtterance', FakeSpeechUtterance);
    const device = new BrowserVoiceMediaDevice();

    expect(device.capabilities.playbackDucking).toBe(true);
    const playback = device.speak({
      sequence: 1,
      type: 'playback-start',
      playbackId: 'playback-1',
      text: 'Narration in progress',
    });
    utterance?.onstart?.();
    playback.duck?.(0.2, 300, 8_000);

    await vi.advanceTimersByTimeAsync(150);
    expect(utterance?.volume).toBeLessThan(1);
    expect(utterance?.volume).toBeGreaterThan(0.2);
    await vi.advanceTimersByTimeAsync(150);
    expect(utterance?.volume).toBeCloseTo(0.2);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(600);
    expect(utterance?.volume).toBeCloseTo(1);

    utterance?.onend?.();
    await expect(playback.completion).resolves.toEqual({ playbackId: 'playback-1', outcome: 'completed' });
  });
});
