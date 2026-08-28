import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SpeechPresenceDetector, SpeechPresenceWindow } from '../src/types/clientCaptureActivity.ts';
import type {
  VoiceMediaCapabilities,
  VoiceMediaCapture,
  VoiceMediaClientEvent,
  VoiceMediaDevice,
  VoiceMediaPlayback,
  VoiceMediaTransport,
} from '../src/types/clientMedia.ts';
import { VoiceMediaClient } from '../web/voiceMediaClient.ts';

const capabilities: VoiceMediaCapabilities = {
  capture: true,
  playback: false,
  captureActivity: true,
  autonomousOrchestration: true,
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
  public async reset(): Promise<void> {}
  public async close(): Promise<void> {}
}

class FakeDevice implements VoiceMediaDevice {
  public readonly capabilities = capabilities;
  public readonly callbacks: Array<(pcm: Uint8Array) => void> = [];
  public readonly captures: Array<VoiceMediaCapture & { stop: ReturnType<typeof vi.fn> }> = [];
  public close = vi.fn(async () => undefined);
  public detectors: SpeechPresenceDetector[] = [];

  public createSpeechPresenceDetector(): SpeechPresenceDetector | undefined {
    return this.detectors.shift();
  }
  public async startCapture(onPcm: (pcm: Uint8Array) => void): Promise<VoiceMediaCapture> {
    this.callbacks.push(onPcm);
    const capture = { stop: vi.fn(async () => undefined) };
    this.captures.push(capture);
    return capture;
  }
  public speak(): VoiceMediaPlayback {
    throw new Error('not used');
  }
}

class FakeTransport implements VoiceMediaTransport {
  public readonly connectionIds: string[] = [];
  public readonly disconnect = vi.fn(async () => undefined);
  public readonly captureStopped = vi.fn(async () => undefined);
  public readonly playbackFinished = vi.fn(async () => undefined);
  public readonly audioSends: Array<{ connectionId: string; pcm: Uint8Array }> = [];
  public readonly longPolls: Array<{ reject(error: Error): void; aborted: boolean }> = [];
  public startsEveryConnection = true;
  public sendFailure: Error | undefined;

  public async connect(_clientId: string, connectionId: string): Promise<{ version: 5; cursor: number }> {
    this.connectionIds.push(connectionId);
    return { version: 5, cursor: 0 };
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
    const record = { reject: poll.reject, aborted: false };
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
  public async sendAudio(_clientId: string, connectionId: string, _captureId: string, pcm: Uint8Array): Promise<void> {
    this.audioSends.push({ connectionId, pcm });
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
});
