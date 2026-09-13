import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserRealtimeSession } from '../src/web/api/browserRealtimeSession';

class FakeTrack {
  public readonly kind = 'audio';
  public enabled = true;
  public onended: (() => void) | null = null;
  public readonly stop = vi.fn();
}

class FakeStream {
  public constructor(public readonly track = new FakeTrack()) {}
  public getTracks(): FakeTrack[] {
    return [this.track];
  }
  public getAudioTracks(): FakeTrack[] {
    return [this.track];
  }
}

class FakeChannel extends EventTarget {
  public readyState: string = 'connecting';
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public onclose: (() => void) | null = null;
  public readonly sent: string[] = [];
  private readonly listeners = new Map<string, number>();
  public readonly close = vi.fn(() => {
    this.readyState = 'closed';
  });
  public override addEventListener(...args: Parameters<EventTarget['addEventListener']>): void {
    this.listeners.set(args[0], (this.listeners.get(args[0]) ?? 0) + 1);
    super.addEventListener(...args);
  }
  public override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>): void {
    this.listeners.set(args[0], Math.max(0, (this.listeners.get(args[0]) ?? 0) - 1));
    super.removeEventListener(...args);
  }
  public listenerCount(type: string): number {
    return this.listeners.get(type) ?? 0;
  }
  public send(value: string): void {
    this.sent.push(value);
  }
  public open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }
  public message(value: unknown): void {
    this.onmessage?.({ data: value });
  }
  public fail(): void {
    this.onerror?.();
  }
}

interface FakeDescription {
  type?: string;
  sdp?: string;
}

class FakePeer extends EventTarget {
  public static instances: FakePeer[] = [];
  public static iceComplete = true;
  public static autoConnect = true;
  public readonly channel = new FakeChannel();
  public readonly operations: string[] = [];
  private readonly listeners = new Map<string, number>();
  public connectionState: string = 'new';
  public iceGatheringState: string = FakePeer.iceComplete ? 'complete' : 'gathering';
  public localDescription: FakeDescription | null = null;
  public onconnectionstatechange: (() => void) | null = null;
  public ontrack: ((event: { track: FakeTrack; streams: FakeStream[] }) => void) | null = null;
  public readonly close = vi.fn(() => {
    this.connectionState = 'closed';
  });
  public remoteDescriptions: FakeDescription[] = [];

  public constructor() {
    super();
    FakePeer.instances.push(this);
  }
  public override addEventListener(...args: Parameters<EventTarget['addEventListener']>): void {
    this.listeners.set(args[0], (this.listeners.get(args[0]) ?? 0) + 1);
    super.addEventListener(...args);
  }
  public override removeEventListener(...args: Parameters<EventTarget['removeEventListener']>): void {
    this.listeners.set(args[0], Math.max(0, (this.listeners.get(args[0]) ?? 0) - 1));
    super.removeEventListener(...args);
  }
  public listenerCount(type: string): number {
    return this.listeners.get(type) ?? 0;
  }
  public createDataChannel(label: string): FakeChannel {
    this.operations.push(`channel:${label}`);
    return this.channel;
  }
  public addTrack(): void {
    this.operations.push('track');
  }
  public async createOffer(): Promise<FakeDescription> {
    this.operations.push('offer');
    return { type: 'offer', sdp: 'browser-offer' };
  }
  public async setLocalDescription(description: FakeDescription): Promise<void> {
    this.localDescription = description;
  }
  public async setRemoteDescription(description: FakeDescription): Promise<void> {
    this.remoteDescriptions.push(description);
    if (FakePeer.autoConnect) this.connect();
  }
  public connect(): void {
    this.connectionState = 'connected';
    this.channel.open();
    this.dispatchEvent(new Event('connectionstatechange'));
    this.onconnectionstatechange?.();
  }
  public remoteTrack(stream: FakeStream): void {
    this.ontrack?.({ track: stream.track, streams: [stream] });
  }
}

class FakeAudio {
  public autoplay = false;
  public muted = false;
  public srcObject: unknown = null;
  public onplaying: (() => void) | null = null;
  public onpause: (() => void) | null = null;
  public onended: (() => void) | null = null;
  public onwaiting: (() => void) | null = null;
  public readonly play = vi.fn(async () => undefined);
  public readonly pause = vi.fn();
  public playbackStarted(): void {
    this.onplaying?.();
  }
  public playbackPaused(): void {
    this.onpause?.();
  }
}

const createAudioElement = vi.fn(() => new FakeAudio());

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  FakePeer.instances = [];
  FakePeer.iceComplete = true;
  FakePeer.autoConnect = true;
  createAudioElement.mockClear();
  vi.stubGlobal('RTCPeerConnection', FakePeer);
  vi.stubGlobal('MediaStream', FakeStream);
  vi.stubGlobal('document', { createElement: createAudioElement });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function installMicrophone(stream = new FakeStream()): FakeStream {
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
  return stream;
}

describe('BrowserRealtimeSession', () => {
  it('creates oai-events before the offer and connects browser microphone media', async () => {
    const stream = installMicrophone();
    const states: string[] = [];
    const negotiate = vi.fn(async () => 'provider-answer');
    const session = new BrowserRealtimeSession({
      negotiate,
      onEvent: vi.fn(),
      onState: (state) => states.push(`${state.connection}:${state.listening}`),
    });

    await session.start();

    const peer = FakePeer.instances[0]!;
    expect(peer.operations).toEqual(['channel:oai-events', 'track', 'offer']);
    expect(negotiate).toHaveBeenCalledWith('browser-offer', expect.any(AbortSignal));
    expect(states).toEqual(['connecting:false', 'connected:true']);
    expect(stream.track.stop).not.toHaveBeenCalled();

    session.send('{"type":"session.update"}');
    expect(peer.channel.sent).toEqual(['{"type":"session.update"}']);
  });

  it('applies mute state to a microphone acquired after mute is requested', async () => {
    const stream = installMicrophone();
    const states: Array<{ listening: boolean; muted: boolean }> = [];
    const session = new BrowserRealtimeSession({
      negotiate: async () => 'answer',
      onEvent: vi.fn(),
      onState: (state) => states.push(state),
    });

    session.mute(true);
    await session.start();

    expect(stream.track.enabled).toBe(false);
    expect(states.at(-1)).toMatchObject({ listening: false, muted: true });
  });

  it('closes microphone, peer, channel, and output immediately', async () => {
    const stream = installMicrophone();
    const states: string[] = [];
    const session = new BrowserRealtimeSession({
      negotiate: async () => 'answer',
      onEvent: vi.fn(),
      onState: (state) => states.push(state.connection),
    });
    await session.start();
    const peer = FakePeer.instances[0]!;
    const remote = new FakeStream();
    peer.remoteTrack(remote);
    const audio = createAudioElement.mock.results[0]!.value;

    session.close();

    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(peer.channel.close).toHaveBeenCalledOnce();
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.srcObject).toBeNull();
    expect(states.at(-1)).toBe('closed');
  });

  it('reports permission rejection without creating an RTC peer', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => Promise.reject(new DOMException('denied', 'NotAllowedError'))) },
    });
    const states: Array<{ connection: string; error?: string }> = [];
    const session = new BrowserRealtimeSession({
      negotiate: vi.fn(),
      onEvent: vi.fn(),
      onState: (state) => states.push(state),
    });

    await expect(session.start()).rejects.toThrow('denied');
    expect(FakePeer.instances).toHaveLength(0);
    expect(states.at(-1)?.connection).toBe('failed');
    expect(states.at(-1)?.error).toContain('NotAllowedError');
  });

  it('settles start while microphone capture is pending and stops the late stream', async () => {
    let resolveCapture!: (stream: FakeStream) => void;
    const capture = new Promise<FakeStream>((resolve) => {
      resolveCapture = resolve;
    });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(() => capture) } });
    const session = new BrowserRealtimeSession({ negotiate: vi.fn(), onEvent: vi.fn(), onState: vi.fn() });
    const result = session.start().then(
      () => 'resolved',
      (error: unknown) => String(error),
    );
    await flush();

    session.close();

    expect(await result).toContain('closed');
    expect(FakePeer.instances).toHaveLength(0);
    const lateStream = new FakeStream();
    resolveCapture(lateStream);
    await flush();
    expect(lateStream.track.stop).toHaveBeenCalledOnce();
  });

  it('cancels negotiation and ignores its late answer after close', async () => {
    const stream = installMicrophone();
    let resolveNegotiation!: (sdp: string) => void;
    const negotiation = new Promise<string>((resolve) => {
      resolveNegotiation = resolve;
    });
    const session = new BrowserRealtimeSession({ negotiate: () => negotiation, onEvent: vi.fn(), onState: vi.fn() });
    const result = session.start().then(
      () => 'resolved',
      (error: unknown) => String(error),
    );
    await flush();
    const peer = FakePeer.instances[0]!;

    session.close();
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(await result).toContain('closed');
    resolveNegotiation('late-answer');
    await flush();
    expect(peer.remoteDescriptions).toHaveLength(0);
  });

  it('stops transmission when the event channel fails', async () => {
    const stream = installMicrophone();
    const states: string[] = [];
    const session = new BrowserRealtimeSession({
      negotiate: async () => 'answer',
      onEvent: vi.fn(),
      onState: (state) => states.push(state.connection),
    });
    await session.start();

    FakePeer.instances[0]!.channel.fail();

    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(states.at(-1)).toBe('failed');
  });

  it('derives speaking only from observable playback and keeps interruption local', async () => {
    const stream = installMicrophone();
    const states: Array<{ listening: boolean; speaking: boolean; muted: boolean }> = [];
    const onEvent = vi.fn();
    const session = new BrowserRealtimeSession({
      negotiate: async () => 'answer',
      onEvent,
      onState: (state) => states.push(state),
    });
    await session.start();
    const peer = FakePeer.instances[0]!;
    peer.remoteTrack(new FakeStream());
    const audio = createAudioElement.mock.results[0]!.value;

    peer.channel.message('{"type":"output_transcript.added","item":{"text":"hello"}}');
    peer.channel.message('{"type":"output_audio.delta","audio":"encoded"}');
    peer.channel.message('{"type":"response.created","response":{"id":"guessed-ga"}}');
    peer.channel.message('{"type":"response.failed","response":{"id":"guessed-ga"}}');
    expect(states.at(-1)?.speaking).toBe(false);

    audio.playbackStarted();
    expect(states.at(-1)?.speaking).toBe(true);
    audio.playbackPaused();
    expect(states.at(-1)?.speaking).toBe(false);
    audio.playbackStarted();

    session.interruptSpeech();

    expect(audio.muted).toBe(true);
    expect(stream.track.enabled).toBe(true);
    expect(states.at(-1)).toMatchObject({ listening: true, speaking: false, muted: false });
    peer.channel.message('{"type":"response.created","response":{"id":"two"}}');
    peer.channel.message('{"type":"output_audio.delta","audio":"next"}');
    audio.playbackStarted();
    expect(audio.muted).toBe(true);
    expect(states.at(-1)?.speaking).toBe(false);
    expect(onEvent).toHaveBeenCalledTimes(6);
  });

  it('rejects malformed or oversized outgoing events and closes on malformed provider events', async () => {
    const stream = installMicrophone();
    const onEvent = vi.fn();
    const session = new BrowserRealtimeSession({ negotiate: async () => 'answer', onEvent, onState: vi.fn() });
    await session.start();

    expect(() => session.send('not-json')).toThrow('valid JSON');
    expect(() => session.send(JSON.stringify({ type: 'large', value: 'x'.repeat(65_536) }))).toThrow('maximum size');
    FakePeer.instances[0]!.channel.message('not-json');

    expect(onEvent).not.toHaveBeenCalled();
    expect(stream.track.stop).toHaveBeenCalledOnce();
  });

  it('observes provider errors by failing closed without forwarding them', async () => {
    const stream = installMicrophone();
    const onEvent = vi.fn();
    const states: string[] = [];
    const session = new BrowserRealtimeSession({
      negotiate: async () => 'answer',
      onEvent,
      onState: (state) => states.push(state.connection),
    });
    await session.start();

    FakePeer.instances[0]!.channel.message('{"type":"error","error":{"message":"provider failed"}}');

    expect(onEvent).not.toHaveBeenCalled();
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(states.at(-1)).toBe('failed');
  });

  it('stops the microphone when its track ends', async () => {
    const stream = installMicrophone();
    const states: string[] = [];
    const session = new BrowserRealtimeSession({
      negotiate: async () => 'answer',
      onEvent: vi.fn(),
      onState: (state) => states.push(state.connection),
    });
    await session.start();

    stream.track.onended?.();

    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(states.at(-1)).toBe('failed');
  });

  it('removes ICE and connection listeners after readiness changes', async () => {
    FakePeer.iceComplete = false;
    FakePeer.autoConnect = false;
    installMicrophone();
    const session = new BrowserRealtimeSession({
      negotiate: async () => 'answer',
      onEvent: vi.fn(),
      onState: vi.fn(),
    });
    const started = session.start();
    await flush();
    const peer = FakePeer.instances[0]!;
    expect(peer.listenerCount('icegatheringstatechange')).toBe(1);

    peer.iceGatheringState = 'complete';
    peer.dispatchEvent(new Event('icegatheringstatechange'));
    await flush();
    await flush();
    expect(peer.listenerCount('icegatheringstatechange')).toBe(0);
    expect(peer.listenerCount('connectionstatechange')).toBe(1);

    peer.connect();
    await started;
    expect(peer.listenerCount('connectionstatechange')).toBe(0);
    expect(peer.channel.listenerCount('open')).toBe(0);
    expect(peer.channel.listenerCount('close')).toBe(0);
  });

  it('bounds ICE gathering and cleans up capture on timeout', async () => {
    vi.useFakeTimers();
    FakePeer.iceComplete = false;
    const stream = installMicrophone();
    const negotiate = vi.fn();
    const session = new BrowserRealtimeSession({ negotiate, onEvent: vi.fn(), onState: vi.fn() });
    const result = session.start().then(
      () => 'resolved',
      (error: unknown) => String(error),
    );
    await flush();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(await result).toContain('ICE gathering timed out');
    expect(negotiate).not.toHaveBeenCalled();
    expect(stream.track.stop).toHaveBeenCalledOnce();
    expect(FakePeer.instances[0]!.listenerCount('icegatheringstatechange')).toBe(0);
  });

  it('bounds connection establishment and cleans up capture on timeout', async () => {
    vi.useFakeTimers();
    FakePeer.autoConnect = false;
    const stream = installMicrophone();
    const session = new BrowserRealtimeSession({
      negotiate: async () => 'answer',
      onEvent: vi.fn(),
      onState: vi.fn(),
    });
    const result = session.start().then(
      () => 'resolved',
      (error: unknown) => String(error),
    );
    await flush();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(await result).toContain('connection timed out');
    expect(stream.track.stop).toHaveBeenCalledOnce();
    const peer = FakePeer.instances[0]!;
    expect(peer.listenerCount('connectionstatechange')).toBe(0);
    expect(peer.channel.listenerCount('open')).toBe(0);
    expect(peer.channel.listenerCount('close')).toBe(0);
  });
});
