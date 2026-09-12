import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  VoiceMediaCapture,
  VoiceMediaClientEvent,
  VoiceMediaDevice,
  VoiceMediaPlayback,
  VoiceMediaPlaybackResult,
  VoiceMediaTransport,
} from '../src/types/clientMedia';
import type { BrowserRealtimeOptions, RealtimeBrowserState } from '../src/types/realtime';
import { VoiceMediaClient, type RealtimeBrowserSessionFactory } from '../src/web/api/voiceMediaClient';

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

class FakeDevice implements VoiceMediaDevice {
  public readonly capabilities = {
    capture: true,
    playback: true,
    captureActivity: false,
    autonomousOrchestration: false,
    realtime: true,
  };
  public readonly captures: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  public readonly playbacks: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  public readonly close = vi.fn(async () => undefined);

  public async startCapture(): Promise<VoiceMediaCapture> {
    const capture = { stop: vi.fn(async () => undefined) };
    this.captures.push(capture);
    return capture;
  }

  public speak(request: Extract<VoiceMediaClientEvent, { type: 'playback-start' }>): VoiceMediaPlayback {
    const playback = { stop: vi.fn(), completion: new Promise<VoiceMediaPlaybackResult>(() => undefined) };
    this.playbacks.push(playback);
    return {
      ...playback,
      completion: playback.completion.then(() => ({ playbackId: request.playbackId, outcome: 'completed' })),
    };
  }
}

class FakeTransport implements VoiceMediaTransport {
  public readonly disconnect = vi.fn(async () => undefined);
  public readonly captureStopped = vi.fn(async () => undefined);
  public readonly playbackFinished = vi.fn(async () => undefined);
  public readonly realtimeNegotiate = vi.fn(async () => 'answer');
  public readonly realtimeEvents: string[] = [];
  public readonly realtimeStates: RealtimeBrowserState[] = [];
  public readonly connectionIds: string[] = [];
  private pending:
    | {
        resolve(event: VoiceMediaClientEvent | undefined): void;
        reject(error: Error): void;
      }
    | undefined;

  public async connect(_clientId: string, connectionId: string): Promise<{ version: 6; cursor: number }> {
    this.connectionIds.push(connectionId);
    return { version: 6, cursor: 0 };
  }

  public nextEvent(
    _clientId: string,
    _connectionId: string,
    _after: number,
    signal: AbortSignal,
  ): Promise<VoiceMediaClientEvent | undefined> {
    const next = deferred<VoiceMediaClientEvent | undefined>();
    this.pending = next;
    signal.addEventListener('abort', () => next.reject(new Error('aborted')), { once: true });
    return next.promise;
  }

  public push(event: VoiceMediaClientEvent): void {
    const pending = this.pending;
    if (pending === undefined) throw new Error('No pending browser event poll.');
    this.pending = undefined;
    pending.resolve(event);
  }

  public failConnection(): void {
    const pending = this.pending;
    if (pending === undefined) throw new Error('No pending browser event poll.');
    this.pending = undefined;
    pending.reject(new Error('connection lost'));
  }

  public async sendAudio(): Promise<void> {}

  public realtimeEvent = vi.fn(
    async (_clientId: string, _connectionId: string, _activationId: string, event: string): Promise<void> => {
      this.realtimeEvents.push(event);
    },
  );

  public realtimeState = vi.fn(
    async (
      _clientId: string,
      _connectionId: string,
      _activationId: string,
      state: RealtimeBrowserState,
    ): Promise<void> => {
      this.realtimeStates.push(state);
    },
  );
}

class FakeRealtimeSession {
  public readonly close = vi.fn(() => {
    this.closed = true;
    this.options.onState({ connection: 'closed', listening: false, speaking: false, muted: false });
  });
  public readonly mute = vi.fn((muted: boolean) =>
    this.options.onState({ connection: 'connected', listening: !muted, speaking: false, muted }),
  );
  public readonly interruptSpeech = vi.fn();
  public readonly send = vi.fn();
  public closed = false;

  public constructor(
    private readonly options: BrowserRealtimeOptions,
    private readonly startGate: Promise<void> = Promise.resolve(),
  ) {}

  public async start(): Promise<void> {
    this.options.onState({ connection: 'connecting', listening: false, speaking: false, muted: false });
    await this.startGate;
    if (!this.closed) this.options.onState({ connection: 'connected', listening: true, speaking: false, muted: false });
  }

  public providerEvent(event: string): void {
    this.options.onEvent(event);
  }
}

function realtimeStart(sequence: number, activationId: string): VoiceMediaClientEvent {
  return { sequence, type: 'realtime-start', activationId };
}

function realtimeStop(sequence: number, activationId: string): VoiceMediaClientEvent {
  return { sequence, type: 'realtime-stop', activationId };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('VoiceMediaClient browser realtime integration', () => {
  it('keeps polling and closes synchronously when stop arrives before realtime start completes', async () => {
    const gate = deferred<void>();
    const sessions: FakeRealtimeSession[] = [];
    const factory: RealtimeBrowserSessionFactory = (options) => {
      const session = new FakeRealtimeSession(options, gate.promise);
      sessions.push(session);
      return session;
    };
    const transport = new FakeTransport();
    const client = new VoiceMediaClient(
      'client',
      'connection',
      transport,
      new FakeDevice(),
      undefined,
      undefined,
      factory,
    );
    client.start();
    await eventually(() => expect(transport.connectionIds).toHaveLength(1));

    transport.push(realtimeStart(1, 'activation'));
    await eventually(() => expect(sessions).toHaveLength(1));
    await eventually(() => expect(() => transport.push(realtimeStop(2, 'activation'))).not.toThrow());
    await eventually(() => expect(sessions[0]!.close).toHaveBeenCalledOnce());

    gate.resolve(undefined);
    await Promise.resolve();
    expect(transport.connectionIds).toHaveLength(1);
    await client.stop();
  });

  it('refuses stale activation controls and excludes realtime from legacy capture', async () => {
    const sessions: FakeRealtimeSession[] = [];
    const factory: RealtimeBrowserSessionFactory = (options) => {
      const session = new FakeRealtimeSession(options);
      sessions.push(session);
      return session;
    };
    const device = new FakeDevice();
    const transport = new FakeTransport();
    const client = new VoiceMediaClient('client', 'connection', transport, device, undefined, undefined, factory);
    client.start();
    await eventually(() => expect(transport.connectionIds).toHaveLength(1));
    transport.push(realtimeStart(1, 'current'));
    await eventually(() => expect(sessions).toHaveLength(1));
    await eventually(() => expect(transport.realtimeStates.at(-1)?.connection).toBe('connected'));

    transport.push({ sequence: 2, type: 'realtime-control', activationId: 'stale', action: 'mute' });
    await eventually(() =>
      expect(() =>
        transport.push({ sequence: 3, type: 'realtime-control', activationId: 'current', action: 'mute' }),
      ).not.toThrow(),
    );
    await eventually(() => expect(sessions[0]!.mute).toHaveBeenCalledOnce());

    transport.push({
      sequence: 4,
      type: 'capture-start',
      captureId: 'capture',
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
      configuration: { mode: 'manual', activityControl: 'host' },
    });
    await eventually(() => expect(sessions[0]!.close).toHaveBeenCalledOnce());
    await eventually(() => expect(device.captures).toHaveLength(1));
    await client.stop();
  });

  it('orders browser state and provider event posts, then tears down on a post failure', async () => {
    const sessions: FakeRealtimeSession[] = [];
    const factory: RealtimeBrowserSessionFactory = (options) => {
      const session = new FakeRealtimeSession(options);
      sessions.push(session);
      return session;
    };
    const transport = new FakeTransport();
    const order: string[] = [];
    transport.realtimeState.mockImplementation(async (_client, _connection, _activation, state) => {
      order.push(`state:${state.connection}`);
    });
    const postFailure = deferred<void>();
    transport.realtimeEvent = vi.fn(async (_client, _connection, _activation, event) => {
      order.push(`event:${event}`);
      await postFailure.promise;
    });
    const client = new VoiceMediaClient(
      'client',
      'connection',
      transport,
      new FakeDevice(),
      undefined,
      undefined,
      factory,
    );
    client.start();
    await eventually(() => expect(transport.connectionIds).toHaveLength(1));
    transport.push(realtimeStart(1, 'activation'));
    await eventually(() => expect(sessions).toHaveLength(1));
    sessions[0]!.providerEvent('{"type":"ready"}');
    await eventually(() => expect(order).toContain('event:{"type":"ready"}'));

    postFailure.reject(new Error('state upload failed'));
    await eventually(() => expect(sessions[0]!.close).toHaveBeenCalledOnce());
    await client.stop();
  });

  it('does not recreate realtime microphone media after reconnecting', async () => {
    vi.useFakeTimers();
    const sessions: FakeRealtimeSession[] = [];
    const factory: RealtimeBrowserSessionFactory = (options) => {
      const session = new FakeRealtimeSession(options);
      sessions.push(session);
      return session;
    };
    const transport = new FakeTransport();
    const client = new VoiceMediaClient(
      'client',
      'connection',
      transport,
      new FakeDevice(),
      undefined,
      undefined,
      factory,
    );
    client.start();
    await eventually(() => expect(transport.connectionIds).toHaveLength(1));
    transport.push(realtimeStart(1, 'activation'));
    await eventually(() => expect(sessions).toHaveLength(1));
    transport.failConnection();
    await eventually(() => expect(sessions[0]!.close).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(2_000);
    await eventually(() => expect(transport.connectionIds).toHaveLength(2));
    expect(sessions).toHaveLength(1);
    await client.stop();
  });
  it('drops queued utterances after local end but reports physical closure', async () => {
    const sessions: FakeRealtimeSession[] = [];
    const factory: RealtimeBrowserSessionFactory = (options) => {
      const session = new FakeRealtimeSession(options);
      sessions.push(session);
      return session;
    };
    const transport = new FakeTransport();
    const gate = deferred<void>();
    transport.realtimeEvent.mockImplementationOnce(async () => gate.promise);
    const client = new VoiceMediaClient(
      'client',
      'connection',
      transport,
      new FakeDevice(),
      undefined,
      undefined,
      factory,
    );
    client.start();
    await eventually(() => expect(transport.connectionIds).toHaveLength(1));
    transport.push(realtimeStart(1, 'activation'));
    await eventually(() => expect(transport.realtimeStates.at(-1)?.connection).toBe('connected'));
    sessions[0]!.providerEvent('first-in-flight');
    await eventually(() => expect(transport.realtimeEvent).toHaveBeenCalledOnce());
    sessions[0]!.providerEvent('queued-stale-delegation');
    transport.push(realtimeStop(2, 'activation'));
    await eventually(() => expect(sessions[0]!.close).toHaveBeenCalledOnce());
    gate.resolve(undefined);
    await eventually(() => expect(transport.realtimeStates.at(-1)?.connection).toBe('closed'));
    expect(transport.realtimeEvent).toHaveBeenCalledOnce();
    await client.stop();
  });
});
