import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpeechPresenceDetector, SpeechPresenceWindow } from '../src/types/clientCaptureActivity.ts';
import type {
  VoiceMediaCapabilities,
  VoiceMediaCapture,
  VoiceMediaCaptureActivity,
  VoiceMediaClientEvent,
  VoiceMediaDevice,
  VoiceMediaPlayback,
  VoiceMediaPlaybackOutcome,
  VoiceMediaPlaybackResult,
  VoiceMediaTransport,
} from '../src/types/clientMedia.ts';
import { VoiceMediaClient } from '../src/web/voiceMediaClient.ts';

const capabilities: VoiceMediaCapabilities = {
  capture: true,
  playback: true,
  captureActivity: true,
  autonomousOrchestration: true,
  playbackDucking: true,
};

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await Promise.resolve();
    }
  }
  assertion();
}

class FakeDetector implements SpeechPresenceDetector {
  public constructor(private readonly pushResult: () => Promise<readonly SpeechPresenceWindow[]>) {}
  public push(): Promise<readonly SpeechPresenceWindow[]> {
    return this.pushResult();
  }
  public readonly reset = vi.fn(async () => undefined);
  public readonly close = vi.fn(async () => undefined);
}

interface FakePlayback extends VoiceMediaPlayback {
  duck(targetGain: number, fadeMs: number, holdMs: number): void;
  stop(outcome: Extract<VoiceMediaPlaybackOutcome, 'stopped' | 'aborted'>): void;
  finish(outcome: VoiceMediaPlaybackOutcome): void;
}

class FakeDevice implements VoiceMediaDevice {
  public readonly capabilities = capabilities;
  public readonly callbacks: Array<(pcm: Uint8Array) => void> = [];
  public readonly captures: Array<VoiceMediaCapture & { stop: ReturnType<typeof vi.fn> }> = [];
  public readonly playbacks: FakePlayback[] = [];
  public close = vi.fn(async () => undefined);
  public detectors: SpeechPresenceDetector[] = [];
  public speakError: Error | undefined;

  public createSpeechPresenceDetector(): SpeechPresenceDetector | undefined {
    return this.detectors.shift();
  }
  public async startCapture(onPcm: (pcm: Uint8Array) => void): Promise<VoiceMediaCapture> {
    this.callbacks.push(onPcm);
    const capture = { stop: vi.fn(async () => undefined) };
    this.captures.push(capture);
    return capture;
  }
  public speak(request: Extract<VoiceMediaClientEvent, { type: 'playback-start' }>): VoiceMediaPlayback {
    if (this.speakError !== undefined) throw this.speakError;
    const completion = deferred<VoiceMediaPlaybackResult>();
    let settled = false;
    const finish = (outcome: VoiceMediaPlaybackOutcome): void => {
      if (settled) return;
      settled = true;
      completion.resolve({ playbackId: request.playbackId, outcome });
    };
    const playback: FakePlayback = {
      completion: completion.promise,
      duck: vi.fn(),
      stop: vi.fn((outcome: Extract<VoiceMediaPlaybackOutcome, 'stopped' | 'aborted'>) => finish(outcome)),
      finish,
    };
    this.playbacks.push(playback);
    return playback;
  }
}

class FakeTransport implements VoiceMediaTransport {
  public readonly connectionIds: string[] = [];
  public readonly disconnect = vi.fn(async () => undefined);
  public readonly captureStopped = vi.fn(async () => undefined);
  public readonly playbackFinished = vi.fn(async () => undefined);
  public readonly audioSends: Array<{
    connectionId: string;
    pcm: Uint8Array;
    activity?: VoiceMediaCaptureActivity;
  }> = [];
  public readonly longPolls: Array<{
    resolve(event: VoiceMediaClientEvent | undefined): void;
    reject(error: Error): void;
    aborted: boolean;
  }> = [];
  public startsEveryConnection = true;
  public sendFailure: Error | undefined;
  public connectFailure: Error | undefined;

  public async connect(_clientId: string, connectionId: string): Promise<{ version: 6; cursor: number }> {
    this.connectionIds.push(connectionId);
    if (this.connectFailure !== undefined) throw this.connectFailure;
    return { version: 6, cursor: 0 };
  }
  public nextEvent(
    _clientId: string,
    _connectionId: string,
    after: number,
    signal: AbortSignal,
  ): Promise<VoiceMediaClientEvent | undefined> {
    if (after === 0 && this.startsEveryConnection) {
      return Promise.resolve({
        sequence: 1,
        type: 'capture-start',
        captureId: `capture-${String(this.connectionIds.length)}`,
        sampleRate: 16_000,
        channels: 1,
        bitsPerSample: 16,
        configuration: { mode: 'autonomous', activityControl: 'client' },
      });
    }
    const poll = deferred<VoiceMediaClientEvent | undefined>();
    const record = { resolve: poll.resolve, reject: poll.reject, aborted: false };
    this.longPolls.push(record);
    signal.addEventListener(
      'abort',
      () => {
        record.aborted = true;
        poll.reject(new Error('aborted'));
      },
      { once: true },
    );
    return poll.promise;
  }
  public async sendAudio(
    _clientId: string,
    connectionId: string,
    _captureId: string,
    pcm: Uint8Array,
    activity?: VoiceMediaCaptureActivity,
  ): Promise<void> {
    this.audioSends.push({ connectionId, pcm, ...(activity ? { activity: { ...activity } } : {}) });
    const failure = this.sendFailure;
    this.sendFailure = undefined;
    if (failure !== undefined) throw failure;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

async function reconnect(transport: FakeTransport): Promise<void> {
  await eventually(() => expect(transport.disconnect).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(2_000);
  await eventually(() => expect(transport.connectionIds).toHaveLength(2));
}

describe('voice media client browser recovery', () => {
  it('reports a competing browser lease instead of appearing connected', async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    transport.connectFailure = new Error('Another client owns voice media for this session.');
    const states: string[] = [];
    const client = new VoiceMediaClient('client', 'connection', transport, new FakeDevice(), (state) =>
      states.push(state),
    );

    client.start();
    await eventually(() => expect(states).toContain('conflict'));

    expect(states.slice(0, 2)).toEqual(['connecting', 'conflict']);
    await client.stop();
    expect(states.at(-1)).toBe('disconnected');
  });

  it.each(['detector', 'sendAudio'] as const)(
    '%s rejection tears down once and reconnects with a distinct bounded identity',
    async (failureSource) => {
      vi.useFakeTimers();
      const transport = new FakeTransport();
      const device = new FakeDevice();
      const failure = new Error(`${failureSource} failed`);
      device.detectors.push(
        new FakeDetector(() => (failureSource === 'detector' ? Promise.reject(failure) : Promise.resolve([]))),
      );
      if (failureSource === 'sendAudio') transport.sendFailure = failure;
      const client = new VoiceMediaClient('client', 'x'.repeat(250), transport, device);
      client.start();
      await eventually(() => expect(device.callbacks).toHaveLength(1));

      device.callbacks[0]!(new Uint8Array([1, 2]));
      await eventually(() => expect(device.captures[0]?.stop).toHaveBeenCalledOnce());
      await reconnect(transport);

      expect(transport.captureStopped).toHaveBeenCalledTimes(1);
      expect(transport.connectionIds[0]).not.toBe(transport.connectionIds[1]);
      expect(transport.connectionIds.every((id) => id.length <= 200)).toBe(true);
      await client.stop();
    },
  );

  it('uses a new identity after disconnect failure', async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    transport.disconnect.mockRejectedValueOnce(new Error('disconnect failed'));
    const device = new FakeDevice();
    device.detectors.push(new FakeDetector(() => Promise.resolve([])));
    const client = new VoiceMediaClient('client', 'connection', transport, device);
    client.start();
    await eventually(() => expect(transport.longPolls).toHaveLength(1));
    transport.longPolls[0]!.reject(new Error('connection lost'));

    await reconnect(transport);
    expect(transport.connectionIds).toEqual(['connection:1', 'connection:2']);
    await client.stop();
  });

  it('isolates stale PCM callbacks after recovery', async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    transport.sendFailure = new Error('upload failed');
    const device = new FakeDevice();
    device.detectors.push(new FakeDetector(() => Promise.resolve([])), new FakeDetector(() => Promise.resolve([])));
    const client = new VoiceMediaClient('client', 'connection', transport, device);
    client.start();
    await eventually(() => expect(device.callbacks).toHaveLength(1));
    const staleCallback = device.callbacks[0]!;
    staleCallback(new Uint8Array([1, 1]));
    await reconnect(transport);
    await eventually(() => expect(device.callbacks).toHaveLength(2));

    staleCallback(new Uint8Array([2, 2]));
    device.callbacks[1]!(new Uint8Array([3, 3]));
    await eventually(() => expect(transport.audioSends).toHaveLength(2));
    expect(transport.audioSends[1]?.pcm).toEqual(new Uint8Array([3, 3]));
    await client.stop();
  });

  it('does not let a stale asynchronous detector reply upload after recovery', async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const staleInference = deferred<readonly SpeechPresenceWindow[]>();
    const device = new FakeDevice();
    device.detectors.push(new FakeDetector(() => staleInference.promise), new FakeDetector(() => Promise.resolve([])));
    const client = new VoiceMediaClient('client', 'connection', transport, device);
    client.start();
    await eventually(() => expect(device.callbacks).toHaveLength(1));
    device.callbacks[0]!(new Uint8Array([1, 1]));
    await eventually(() => expect(transport.longPolls).toHaveLength(1));
    transport.longPolls[0]!.reject(new Error('connection lost'));

    await reconnect(transport);
    await eventually(() => expect(device.callbacks).toHaveLength(2));
    staleInference.resolve([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.audioSends).toHaveLength(0);
    device.callbacks[1]!(new Uint8Array([2, 2]));
    await eventually(() => expect(transport.audioSends).toHaveLength(1));
    expect(transport.audioSends[0]?.connectionId).toBe('connection:2');
    await client.stop();
  });

  it('acknowledges unavailable remote playback instead of leaving the host narrating', async () => {
    const transport = new FakeTransport();
    transport.startsEveryConnection = false;
    const device = new FakeDevice();
    device.speakError = new Error('browser playback unavailable');
    const client = new VoiceMediaClient('client', 'connection', transport, device);
    client.start();
    await eventually(() => expect(transport.longPolls).toHaveLength(1));
    transport.longPolls[0]!.resolve({
      sequence: 1,
      type: 'playback-start',
      playbackId: 'unavailable-playback',
      text: 'Narration cannot play here.',
    });

    await eventually(() => expect(transport.playbackFinished).toHaveBeenCalledOnce());

    expect(transport.playbackFinished).toHaveBeenCalledWith('client', 'connection:1', {
      playbackId: 'unavailable-playback',
      outcome: 'failed',
      error: 'Error: browser playback unavailable',
    });
    expect(transport.disconnect).not.toHaveBeenCalled();
    await client.stop();
  });
  it('clean stop aborts the long poll and disconnects exactly once', async () => {
    const transport = new FakeTransport();
    transport.startsEveryConnection = false;
    const device = new FakeDevice();
    const client = new VoiceMediaClient('client', 'connection', transport, device);
    client.start();
    await eventually(() => expect(transport.longPolls).toHaveLength(1));

    await expect(client.stop()).resolves.toBeUndefined();
    expect(transport.longPolls[0]?.aborted).toBe(true);
    expect(transport.disconnect).toHaveBeenCalledOnce();
    expect(device.close).toHaveBeenCalledOnce();
  });

  it('never ducks playback from classifier cues before the host attributes the speaker', async () => {
    const transport = new FakeTransport();
    const device = new FakeDevice();
    const windows: SpeechPresenceWindow[][] = [
      [],
      [{ speech: true, sampleCount: 1_600 }],
      [{ speech: true, sampleCount: 1_600 }],
      [{ speech: true, sampleCount: 1_600 }],
      [{ speech: true, sampleCount: 1_600 }],
      [{ speech: false, sampleCount: 1_600 }],
    ];
    const detector = new FakeDetector(async () => windows.shift() ?? []);
    device.detectors.push(detector);
    const client = new VoiceMediaClient('client', 'connection', transport, device);
    client.start();
    await eventually(() => expect(device.callbacks).toHaveLength(1));

    const pcm = new Uint8Array(3_200);
    device.callbacks[0]!(pcm);
    await eventually(() => expect(transport.audioSends).toHaveLength(1));
    expect(transport.audioSends[0]?.activity).toMatchObject({ epoch: 0, classifiedSpeechMs: 0 });
    await eventually(() => expect(transport.longPolls).toHaveLength(1));
    transport.longPolls[0]!.resolve({
      sequence: 2,
      type: 'playback-start',
      playbackId: 'playback-1',
      text: 'Narration in progress',
    });
    await eventually(() => expect(device.playbacks).toHaveLength(1));

    for (let index = 0; index < 4; index += 1) device.callbacks[0]!(pcm);
    await eventually(() => expect(transport.audioSends).toHaveLength(5));
    expect(device.playbacks[0]?.duck).not.toHaveBeenCalled();
    expect(device.playbacks[0]?.stop).not.toHaveBeenCalled();
    expect(transport.audioSends[4]?.activity).toMatchObject({ epoch: 1, classifiedSpeechMs: 400 });

    device.playbacks[0]!.finish('completed');
    await eventually(() => expect(transport.playbackFinished).toHaveBeenCalledOnce());
    await eventually(() => expect(detector.reset).toHaveBeenCalledTimes(2));
    device.callbacks[0]!(pcm);
    await eventually(() => expect(transport.audioSends).toHaveLength(6));
    expect(transport.audioSends[5]?.activity).toMatchObject({ epoch: 2, classifiedSpeechMs: 0 });

    await client.stop();
  });
});
