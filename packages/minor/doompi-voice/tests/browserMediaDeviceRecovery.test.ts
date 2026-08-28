import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserVoiceMediaDevice, Pcm16Resampler } from '../web/browserMediaDevice.ts';
class FakeNode {
  public connect(): void {}
  public disconnect(): void {}
}

class FakeScriptProcessor extends FakeNode {
  public onaudioprocess: ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null =
    null;
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
  public createBuffer(): { copyToChannel: (samples: Float32Array) => void } {
    return { copyToChannel: (samples) => this.copiedSamples.push(samples) };
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

    await device.prepare();
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
