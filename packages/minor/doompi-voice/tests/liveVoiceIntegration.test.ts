import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoiceMediaApi } from '../src/adapters/clientMediaApi.ts';
import { LiveVoiceController } from '../src/adapters/pi/liveVoiceController.ts';
import type { RealtimeHost } from '../src/adapters/realtime/realtimeHost.ts';
import type { AutoCaptureUi, IClock } from '../src/types/index.ts';
import type {
  BrowserRealtimeOptions,
  RealtimeBrowserState,
  RealtimeProvider,
  RealtimeHostSnapshot,
} from '../src/types/realtime.ts';
import { REALTIME_ROUTES } from '../src/types/realtime.ts';
import type {
  VoiceMediaCapabilities,
  VoiceMediaCapture,
  VoiceMediaClientEvent,
  VoiceMediaDevice,
  VoiceMediaPlayback,
  VoiceMediaPlaybackResult,
  VoiceMediaTransport,
} from '../src/types/clientMedia.ts';
import { VOICE_MEDIA_PROTOCOL_VERSION, VOICE_MEDIA_ROUTES } from '../src/types/clientMedia.ts';
import { VOICE_OWNERSHIP_ROUTES } from '../src/types/voiceOwnership.ts';
import { VoiceMediaClient, type RealtimeBrowserSessionFactory } from '../src/web/api/voiceMediaClient.ts';

const clock: IClock = {
  now: () => Date.now(),
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: (timer) => clearTimeout(timer),
};

function json(value: object): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}

class InMemoryMediaTransport implements VoiceMediaTransport {
  public readonly connections: string[] = [];
  private currentPollReject: ((error: Error) => void) | undefined;

  public constructor(private readonly api: ReturnType<typeof createVoiceMediaApi>) {}

  public get polling(): boolean {
    return this.currentPollReject !== undefined;
  }

  public injectTransportLoss(): void {
    this.currentPollReject?.(new Error('injected media transport loss'));
  }

  public async connect(
    clientId: string,
    connectionId: string,
    capabilities: VoiceMediaCapabilities,
  ): Promise<{ version: 6; cursor: number }> {
    this.connections.push(connectionId);
    return this.requestJson(
      VOICE_MEDIA_ROUTES.clientConnect,
      json({
        version: VOICE_MEDIA_PROTOCOL_VERSION,
        clientId,
        connectionId,
        clientKind: 'browser',
        controlLocation: 'remote',
        capabilities,
      }),
    ) as Promise<{ version: 6; cursor: number }>;
  }

  public async disconnect(clientId: string, connectionId: string): Promise<void> {
    await this.request(VOICE_MEDIA_ROUTES.clientDisconnect, json({ clientId, connectionId }), [204, 409]);
  }

  public async nextEvent(
    clientId: string,
    connectionId: string,
    after: number,
    signal: AbortSignal,
  ): Promise<VoiceMediaClientEvent | undefined> {
    const query = new URLSearchParams({ clientId, connectionId, after: String(after) });
    let rejectPoll!: (error: Error) => void;
    const transportLoss = new Promise<never>((_resolve, reject) => {
      rejectPoll = reject;
    });
    this.currentPollReject = rejectPoll;
    try {
      const response = await Promise.race([
        this.api.fetch(
          new Request(`http://voice.test${VOICE_MEDIA_ROUTES.clientEvents}?${query.toString()}`, { signal }),
        ),
        transportLoss,
      ]);
      if (response.status === 204) return undefined;
      await this.assertOk(response);
      return response.json() as Promise<VoiceMediaClientEvent>;
    } finally {
      if (this.currentPollReject === rejectPoll) this.currentPollReject = undefined;
    }
  }

  public async realtimeNegotiate(
    clientId: string,
    connectionId: string,
    activationId: string,
    sdp: string,
    signal: AbortSignal,
  ): Promise<string> {
    const result = (await this.requestJson(REALTIME_ROUTES.clientNegotiate, {
      ...json({ clientId, connectionId, activationId, sdp }),
      signal,
    })) as { sdp: string };
    return result.sdp;
  }

  public async realtimeEvent(
    clientId: string,
    connectionId: string,
    activationId: string,
    event: string,
  ): Promise<void> {
    await this.request(REALTIME_ROUTES.clientEvent, json({ clientId, connectionId, activationId, event }), [204]);
  }

  public async realtimeState(
    clientId: string,
    connectionId: string,
    activationId: string,
    state: RealtimeBrowserState,
  ): Promise<void> {
    await this.request(REALTIME_ROUTES.clientState, json({ clientId, connectionId, activationId, state }), [204]);
  }

  public async sendAudio(): Promise<void> {}
  public async captureStopped(): Promise<void> {}
  public async playbackFinished(): Promise<void> {}

  private async requestJson(route: string, init: RequestInit): Promise<unknown> {
    const response = await this.request(route, init, [200, 201]);
    return response.json();
  }

  private async request(route: string, init: RequestInit, statuses: number[]): Promise<Response> {
    const response = await this.api.fetch(new Request(`http://voice.test${route}`, init));
    if (!statuses.includes(response.status)) await this.assertOk(response);
    return response;
  }

  private async assertOk(response: Response): Promise<void> {
    if (response.ok) return;
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `media request failed (${response.status})`);
  }
}

class InMemoryAuthenticatedHost implements RealtimeHost {
  public constructor(
    private readonly api: ReturnType<typeof createVoiceMediaApi>,
    private readonly token = 'host-token',
  ) {}

  public async start(activationId: string, instructions: string, signal: AbortSignal): Promise<void> {
    await this.post(REALTIME_ROUTES.hostStart, { activationId, instructions }, signal, [201]);
  }

  public async poll(activationId: string, after: number, signal: AbortSignal): Promise<RealtimeHostSnapshot> {
    const query = new URLSearchParams({ activationId, after: String(after) });
    const response = await this.api.fetch(
      new Request(`http://voice.test${REALTIME_ROUTES.hostPoll}?${query.toString()}`, {
        signal,
        headers: { authorization: `Bearer ${this.token}` },
      }),
    );
    await this.assertOk(response);
    return (await response.json()) as RealtimeHostSnapshot;
  }

  public async send(activationId: string, messages: string[], signal: AbortSignal): Promise<void> {
    await this.post(REALTIME_ROUTES.hostSend, { activationId, messages }, signal, [204]);
  }

  public async control(
    activationId: string,
    action: 'mute' | 'unmute' | 'interrupt',
    signal: AbortSignal,
  ): Promise<void> {
    await this.post(REALTIME_ROUTES.hostControl, { activationId, action }, signal, [204]);
  }

  public async stop(activationId: string): Promise<void> {
    await this.post(REALTIME_ROUTES.hostStop, { activationId }, undefined, [204]);
  }

  public async rawStart(activationId: string): Promise<Response> {
    return this.api.fetch(
      new Request(`http://voice.test${REALTIME_ROUTES.hostStart}`, {
        ...json({ activationId, instructions: 'duplicate' }),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      }),
    );
  }

  private async post(route: string, body: object, signal: AbortSignal | undefined, statuses: number[]): Promise<void> {
    const response = await this.api.fetch(
      new Request(`http://voice.test${route}`, {
        ...json(body),
        signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      }),
    );
    if (!statuses.includes(response.status)) await this.assertOk(response);
  }

  private async assertOk(response: Response): Promise<void> {
    if (response.ok) return;
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `host request failed (${response.status})`);
  }
}

class FakeDevice implements VoiceMediaDevice {
  public readonly capabilities = {
    capture: true,
    playback: true,
    captureActivity: false,
    autonomousOrchestration: false,
    realtime: true,
  };
  public readonly startCapture = vi.fn(async (): Promise<VoiceMediaCapture> => ({ stop: async () => undefined }));
  public readonly close = vi.fn(async () => undefined);

  public speak(): VoiceMediaPlayback {
    return {
      completion: new Promise<VoiceMediaPlaybackResult>(() => undefined),
      stop: () => undefined,
    };
  }
}

class FakeBrowserRealtimeSession {
  public readonly sent: string[] = [];
  public readonly controls: string[] = [];
  public readonly close = vi.fn(() => {
    this.options.onState({ connection: 'closed', listening: false, speaking: false, muted: false });
  });
  public answer: string | undefined;

  public constructor(private readonly options: BrowserRealtimeOptions) {}

  public async start(): Promise<void> {
    this.options.onState({ connection: 'connecting', listening: false, speaking: false, muted: false });
    this.answer = await this.options.negotiate('browser-offer', new AbortController().signal);
    this.options.onState({ connection: 'connected', listening: true, speaking: false, muted: false });
  }

  public send(message: string): void {
    this.sent.push(message);
  }
  public mute(muted: boolean): void {
    this.controls.push(muted ? 'mute' : 'unmute');
    this.options.onState({ connection: 'connected', listening: !muted, speaking: false, muted });
  }
  public interruptSpeech(): void {
    this.controls.push('interrupt');
  }
  public providerEvent(event: object): void {
    this.options.onEvent(JSON.stringify(event));
  }
  public browserEnd(): void {
    this.close();
  }
}

function createUi(): AutoCaptureUi {
  return { notify: vi.fn<AutoCaptureUi['notify']>(), setStatus: vi.fn(), setIndicator: vi.fn() };
}

async function createFixture(provider?: RealtimeProvider) {
  let context = 'initial context';
  let busy = false;
  const createCall = vi.fn<RealtimeProvider['createCall']>(async () => ({
    sdp: 'provider-answer',
    callId: 'provider-call',
  }));
  const api = createVoiceMediaApi({
    internalToken: 'host-token',
    realtimeProvider: provider ?? { createCall },
    sessionId: 'session',
    clientConnectWaitMs: 0,
    now: () => Date.now(),
  });
  const authenticated = (route: string, body: object) =>
    api.fetch(
      new Request(`http://voice.test${route}`, {
        ...json(body),
        headers: { 'content-type': 'application/json', authorization: 'Bearer host-token' },
      }),
    );
  expect(
    (
      await authenticated(VOICE_OWNERSHIP_ROUTES.sync, {
        registration: { version: 2, leaseId: 'lease', revision: 1, label: 'Voice', eligible: true, active: true },
        targets: [],
      })
    ).status,
  ).toBe(200);

  const transport = new InMemoryMediaTransport(api);
  const device = new FakeDevice();
  const sessions: FakeBrowserRealtimeSession[] = [];
  const factory: RealtimeBrowserSessionFactory = (options) => {
    const session = new FakeBrowserRealtimeSession(options);
    sessions.push(session);
    return session;
  };
  const client = new VoiceMediaClient('browser', 'connection', transport, device, undefined, undefined, factory);
  client.start();
  // A connect attempt is not an acquired media lease; polling starts after the connection is acknowledged.
  await vi.waitFor(() => expect(transport.polling).toBe(true));
  expect(transport.connections).toHaveLength(1);

  const sends = vi.fn();
  const host = new InMemoryAuthenticatedHost(api);
  const controller = new LiveVoiceController({
    host,
    clock,
    manualState: () => 'idle',
    contextText: () => context,
    isBusy: () => busy,
    send: sends,
    createId: () => 'activation',
  });
  const ui = createUi();
  return {
    api,
    client,
    controller,
    createCall,
    device,
    host,
    sends,
    sessions,
    transport,
    ui,
    setBusy(value: boolean) {
      busy = value;
    },
    setContext(value: string) {
      context = value;
    },
    async activate() {
      await controller.activate(ui);
      await vi.waitFor(() => expect(sessions, controller.activationError).toHaveLength(1));
      await vi.waitFor(() => expect(sessions[0]!.answer).toBe('provider-answer'));
    },
    async ready() {
      sessions[0]!.providerEvent({ type: 'session.started', session: { id: 'provider-session' } });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => expect(controller.state).toBe('active'));
    },
    async close() {
      await controller.shutdown(ui);
      api.close();
      await client.stop();
    },
  };
}

const fixtures: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  vi.useRealTimers();
});

describe('integrated live voice path', () => {
  it('activates through offer/answer and delivers one fresh transcript with bounded correlated context', async () => {
    vi.useFakeTimers();
    const f = await createFixture();
    fixtures.push(f);
    await f.activate();
    expect(f.createCall).toHaveBeenCalledOnce();
    const call = f.createCall.mock.calls[0]![0];
    expect(call.sdp).toBe('browser-offer');
    expect(call.instructions).toContain('initial context');
    expect(f.controller.state).toBe('starting');
    await f.ready();

    f.setContext('updated '.repeat(90));
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() =>
      expect(f.sessions[0]!.sent.some((message) => message.includes('session.context.append'))).toBe(true),
    );
    const contextMessages = f.sessions[0]!.sent.map(
      (message) =>
        JSON.parse(message) as {
          type: string;
          content: Array<{ text: string }>;
        },
    ).filter((message) => message.type === 'session.context.append');
    expect(contextMessages.length).toBeGreaterThan(1);
    expect(
      contextMessages.every((message) => new TextEncoder().encode(message.content[0]!.text).byteLength <= 500),
    ).toBe(true);

    f.setBusy(true);
    f.sessions[0]!.providerEvent({ type: 'turn.done', turn: { role: 'user', transcript: 'Run the focused tests' } });
    f.sessions[0]!.providerEvent({
      type: 'delegation.created',
      item: {
        id: 'request-1',
        type: 'delegation',
        target: 'client',
        content: [{ type: 'input_text', text: 'rewritten request' }],
      },
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(f.sends).toHaveBeenCalledOnce());
    expect(f.sends).toHaveBeenCalledWith('Run the focused tests', 'immediate');

    f.sessions[0]!.providerEvent({
      type: 'delegation.created',
      item: {
        id: 'request-1',
        type: 'delegation',
        target: 'client',
        content: [{ type: 'input_text', text: 'rewritten request' }],
      },
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    expect(f.sends).toHaveBeenCalledOnce();
    const result = f.sessions[0]!.sent.map((message) => JSON.parse(message) as Record<string, unknown>).find(
      (message) => message.type === 'delegation.context.append',
    );
    expect(result).toMatchObject({ delegation_item_id: 'request-1', channel: 'commentary' });
    expect(result?.content).toEqual([{ type: 'input_text', text: 'submitted' }]);
    await f.controller.publishAgentResult('pi-final', 'Actual fixture receipt: integration-789');
    await vi.waitFor(() =>
      expect(f.sessions[0]!.sent.some((message) => message.includes('integration-789'))).toBe(true),
    );
    const completion = f.sessions[0]!.sent.map((message) => JSON.parse(message)).find(
      (message) => message.channel === 'speakable',
    );
    expect(completion).toMatchObject({ type: 'delegation.context.append', delegation_item_id: 'request-1' });
    expect(completion.content[0].text).toContain('Actual fixture receipt: integration-789');
  });

  it('rejects duplicate and stale activation, forwards mute controls, and ends from either side', async () => {
    vi.useFakeTimers();
    const f = await createFixture();
    fixtures.push(f);
    await Promise.all([f.controller.activate(f.ui), f.controller.activate(f.ui)]);
    await vi.waitFor(() => expect(f.sessions).toHaveLength(1));
    expect(f.controller.activationId).toBe(1);
    expect((await f.host.rawStart('stale-activation')).status).toBe(409);
    await f.ready();

    f.controller.setMicrophoneMuted(true);
    f.controller.setMicrophoneMuted(false);
    await vi.waitFor(() => expect(f.sessions[0]!.controls).toEqual(['mute', 'unmute']));
    f.sessions[0]!.browserEnd();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(f.controller.state).toBe('disabled'));
    expect((await f.host.rawStart('activation')).status).toBe(409);

    const second = await createFixture();
    fixtures.push(second);
    await second.activate();
    await second.ready();
    await second.controller.deactivate(second.ui);
    await vi.waitFor(() => expect(second.sessions[0]!.close).toHaveBeenCalled());
    expect(second.controller.state).toBe('disabled');
  });

  it('fails closed for provider errors, exact narration, and unqualified voice approval', async () => {
    vi.useFakeTimers();
    const f = await createFixture();
    fixtures.push(f);
    await f.activate();
    await f.ready();
    expect(await f.controller.narrateAgent('exact words')).toBe('failed');

    f.controller.askUserBlocked(true);
    f.sessions[0]!.providerEvent({ type: 'turn.done', turn: { role: 'user', transcript: 'Approve it' } });
    f.sessions[0]!.providerEvent({
      type: 'delegation.created',
      item: {
        id: 'approval',
        type: 'delegation',
        target: 'client',
        content: [{ type: 'input_text', text: 'approve action' }],
      },
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    expect(f.sends).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(f.sessions[0]!.sent.some((message) => message.includes('rejected'))).toBe(true));

    f.sessions[0]!.providerEvent({ type: 'error', code: 'provider_failed' });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(f.controller.state).toBe('disabled'));
    expect(f.ui.notify).toHaveBeenCalledWith('Live voice connection failed.', 'error');

    const createCall = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const negotiationFailure = await createFixture({ createCall });
    fixtures.push(negotiationFailure);
    await negotiationFailure.controller.activate(negotiationFailure.ui);
    await vi.waitFor(() => expect(createCall).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(negotiationFailure.controller.state).toBe('disabled'));
    expect(negotiationFailure.sends).not.toHaveBeenCalled();
  });

  it('does not resume realtime microphone media after an authenticated transport reconnection', async () => {
    vi.useFakeTimers();
    const f = await createFixture();
    fixtures.push(f);
    await f.activate();
    await f.ready();
    expect(f.device.startCapture).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(f.transport.polling).toBe(true));
    f.transport.injectTransportLoss();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(f.transport.connections.length).toBeGreaterThan(1));
    expect(f.sessions).toHaveLength(1);
    expect(f.device.startCapture).not.toHaveBeenCalled();
    expect(f.sessions[0]!.close).toHaveBeenCalled();
  });
});
