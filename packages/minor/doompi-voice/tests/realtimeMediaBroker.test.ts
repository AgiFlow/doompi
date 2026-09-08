import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoiceMediaApi } from '../src/adapters/clientMediaApi.ts';
import { RealtimeMediaBroker } from '../src/adapters/realtime/realtimeMediaBroker.ts';
import { REALTIME_ROUTES as routes } from '../src/types/realtime.ts';
import { VOICE_MEDIA_PROTOCOL_VERSION, VOICE_MEDIA_ROUTES } from '../src/types/clientMedia.ts';
import { VOICE_OWNERSHIP_ROUTES } from '../src/types/voiceOwnership.ts';

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});
const owner = { clientId: 'browser', connectionId: 'connection', activationId: 'activation' };
function fixture(fakeTimers = false) {
  let now = 0;
  if (fakeTimers) {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  }
  const createCall = vi.fn(async () => ({ sdp: 'answer', callId: 'rtc_test' }));
  const wakePublish = vi.fn();
  const api = createVoiceMediaApi({
    internalToken: 'host-token',
    realtimeProvider: { createCall },
    sessionId: 'session',
    clientConnectWaitMs: 0,
    now: () => (fakeTimers ? Date.now() : now),
    wakePublisher: { publish: wakePublish },
  });
  disposers.push(() => api.close());
  const post = (route: string, body: object, authorized = true) =>
    api.fetch(
      new Request(`http://voice.test${route}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(authorized && route.startsWith('/host/') ? { authorization: 'Bearer host-token' } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  const poll = (after = 0) =>
    api.fetch(
      new Request(`http://voice.test${routes.hostPoll}?activationId=activation&after=${after}`, {
        headers: { authorization: 'Bearer host-token' },
      }),
    );
  const syncOwnership = () =>
    post(VOICE_OWNERSHIP_ROUTES.sync, {
      registration: {
        version: 2,
        leaseId: 'lease',
        revision: 1,
        label: 'Voice',
        eligible: true,
        active: true,
      },
      targets: [],
    });
  const prepare = async (realtime = true) => {
    expect((await syncOwnership()).status).toBe(200);
    expect(
      (
        await post(VOICE_MEDIA_ROUTES.clientConnect, {
          version: VOICE_MEDIA_PROTOCOL_VERSION,
          clientId: owner.clientId,
          connectionId: owner.connectionId,
          clientKind: 'browser',
          controlLocation: 'remote',
          capabilities: {
            capture: true,
            playback: true,
            captureActivity: false,
            autonomousOrchestration: false,
            realtime,
          },
        })
      ).status,
    ).toBe(200);
  };
  const start = () => post(routes.hostStart, { activationId: owner.activationId, instructions: 'Bounded companion.' });
  const connect = async () => {
    await prepare();
    expect((await start()).status).toBe(201);
    expect(await (await post(routes.clientNegotiate, { ...owner, sdp: 'offer' })).json()).toEqual({ sdp: 'answer' });
    await post(routes.clientState, {
      ...owner,
      state: { connection: 'connected', listening: true, speaking: false, muted: false },
    });
    await post(routes.clientEvent, {
      ...owner,
      event: JSON.stringify({ type: 'session.started', session: { id: 'provider' } }),
    });
    expect(await (await poll()).json()).toMatchObject({ state: 'active' });
  };
  return {
    api,
    post,
    poll,
    prepare,
    syncOwnership,
    start,
    connect,
    createCall,
    wakePublish,
    advance: (milliseconds: number) => {
      if (fakeTimers) vi.advanceTimersByTime(milliseconds);
      else now += milliseconds;
    },
  };
}

describe('authenticated live voice media broker', () => {
  it('requires host authorization and an eligible realtime browser before call creation', async () => {
    const f = fixture();
    expect((await f.post(routes.hostStart, { activationId: 'activation', instructions: '' }, false)).status).toBe(404);
    expect((await f.start()).status).toBe(503);
    await f.prepare(false);
    expect((await f.start()).status).toBe(503);
    expect(f.createCall).not.toHaveBeenCalled();
  });

  it('carries only SDP and bounded events across the authenticated media connection', async () => {
    const f = fixture();
    await f.connect();
    expect(f.createCall).toHaveBeenCalledOnce();
    await f.post(routes.clientEvent, {
      ...owner,
      event: JSON.stringify({
        type: 'delegation.created',
        item: {
          id: 'request',
          type: 'delegation',
          target: 'client',
          content: [null, { type: 'input_text', text: 'Run tests' }],
        },
      }),
    });
    const snapshot = await (await f.poll()).json();
    expect(snapshot).toMatchObject({
      events: expect.arrayContaining([
        expect.objectContaining({ event: { type: 'request', requestId: 'request', text: 'Run tests' } }),
      ]),
    });
    expect(JSON.stringify(snapshot)).not.toContain('accessToken');
    expect(
      (
        await f.post(routes.hostSend, {
          activationId: owner.activationId,
          messages: ['{"type":"session.context.append"}'],
        })
      ).status,
    ).toBe(204);
    for (const action of ['mute', 'unmute', 'interrupt'])
      expect((await f.post(routes.hostControl, { activationId: owner.activationId, action })).status).toBe(204);
    expect((await f.post(routes.hostStop, { activationId: owner.activationId })).status).toBe(204);
    expect(await (await f.poll()).json()).toMatchObject({ state: 'closed' });
  });

  it('rejects stale connection and activation identities before negotiation', async () => {
    const f = fixture();
    await f.prepare();
    await f.start();
    expect((await f.post(routes.clientNegotiate, { ...owner, connectionId: 'stale', sdp: 'offer' })).status).toBe(409);
    expect((await f.post(routes.clientNegotiate, { ...owner, activationId: 'stale', sdp: 'offer' })).status).toBe(409);
    expect(f.createCall).not.toHaveBeenCalled();
  });

  it('rejects legacy capture and playback during live reservation, including concurrent starts', async () => {
    const f = fixture();
    await f.prepare();
    const starts = await Promise.all([f.start(), f.start()]);
    expect(starts.map((response) => response.status).sort((a, b) => a - b)).toEqual([201, 409]);
    expect(
      (
        await f.post(VOICE_MEDIA_ROUTES.hostCaptureStart, {
          captureId: 'capture',
          configuration: { mode: 'manual', activityControl: 'host' },
        })
      ).status,
    ).toBe(409);
    expect((await f.post(VOICE_MEDIA_ROUTES.hostPlaybackStart, { playbackId: 'playback', text: 'Speak' })).status).toBe(
      409,
    );
  });

  it('refuses live activation while manual capture owns media', async () => {
    const f = fixture();
    await f.prepare();
    expect(
      (
        await f.post(VOICE_MEDIA_ROUTES.hostCaptureStart, {
          captureId: 'capture',
          configuration: { mode: 'manual', activityControl: 'host' },
        })
      ).status,
    ).toBe(201);
    expect((await f.start()).status).toBe(409);
  });

  it('closes on browser disconnect and never replays an ended activation', async () => {
    const f = fixture();
    await f.connect();
    await f.post(VOICE_MEDIA_ROUTES.clientDisconnect, owner);
    expect(await (await f.poll()).json()).toMatchObject({ state: 'closed' });
    expect((await f.start()).status).toBe(409);
  });

  it('closes on detected host-control loss even while the browser remains connected', async () => {
    const f = fixture();
    await f.connect();
    f.advance(10_001);
    expect(await (await f.poll()).json()).toMatchObject({ state: 'closed' });
  });

  it('expires stale browser ownership while fresh host polls continue', async () => {
    const f = fixture(true);
    await f.connect();
    for (let elapsed = 5_000; elapsed <= 15_000; elapsed += 5_000) {
      f.advance(5_000);
      expect((await f.syncOwnership()).status).toBe(200);
      expect(await (await f.poll()).json()).toMatchObject({ state: 'active' });
    }
    f.advance(1_000);
    expect(await (await f.poll()).json()).toMatchObject({ state: 'closed' });
    expect(f.wakePublish).toHaveBeenLastCalledWith(expect.objectContaining({ sequence: 2 }));
  });

  it('closes from the host watchdog without another HTTP request', async () => {
    const f = fixture(true);
    await f.connect();
    f.advance(11_000);
    expect(f.wakePublish).toHaveBeenLastCalledWith(expect.objectContaining({ sequence: 2 }));
  });

  it('keeps refreshed client ownership live only until the refreshed lease expires', async () => {
    const f = fixture(true);
    await f.connect();
    f.advance(9_000);
    expect(await (await f.poll()).json()).toMatchObject({ state: 'active' });
    expect((await f.syncOwnership()).status).toBe(200);
    expect((await f.post(VOICE_MEDIA_ROUTES.clientHeartbeat, owner)).status).toBe(200);
    f.advance(7_000);
    expect(await (await f.poll()).json()).toMatchObject({ state: 'active' });
    f.advance(9_000);
    expect(f.wakePublish).toHaveBeenLastCalledWith(expect.objectContaining({ sequence: 2 }));
    expect(await (await f.poll()).json()).toMatchObject({ state: 'closed' });
  });

  it('clears its watchdog and fences a stale callback after closure', () => {
    const timer = 1 as unknown as ReturnType<typeof setTimeout>;
    let watchdog: (() => void) | undefined;
    const clear = vi.fn();
    const publish = vi.fn();
    const broker = new RealtimeMediaBroker({
      identity: { sessionId: 'session', activationId: 'activation', mediaLeaseId: 'lease', connectionId: 'connection' },
      instructions: 'Bounded companion.',
      provider: { createCall: vi.fn() },
      clock: {
        now: () => 0,
        setTimeout: vi.fn(() => timer),
        setInterval: vi.fn((callback) => {
          watchdog = callback;
          return timer;
        }),
        clear,
      },
      ownsMedia: () => true,
      publish,
    });
    broker.start();
    broker.close();
    expect(clear).toHaveBeenCalledWith(timer);
    expect(publish).toHaveBeenCalledTimes(2);
    watchdog?.();
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it('treats provider errors and browser-reported failure as failure, not readiness', async () => {
    const f = fixture();
    await f.connect();
    await f.post(routes.clientEvent, { ...owner, event: '{"type":"error","code":"offline_error"}' });
    expect(await (await f.poll()).json()).toMatchObject({ state: 'failed' });
    const second = fixture();
    await second.connect();
    await second.post(routes.clientState, {
      ...owner,
      state: { connection: 'failed', listening: false, speaking: false, muted: false },
    });
    expect(await (await second.poll()).json()).toMatchObject({ state: 'failed' });
  });

  it('rejects malformed and oversized control traffic without invoking the provider', async () => {
    const f = fixture();
    await f.prepare();
    expect((await f.post(routes.hostStart, { activationId: '', instructions: '' })).status).toBe(400);
    await f.start();
    expect((await f.post(routes.clientNegotiate, { ...owner, sdp: 'x'.repeat(65_537) })).status).toBe(400);
    expect((await f.post(routes.clientEvent, { ...owner, event: 1 })).status).toBe(400);
    expect((await f.post(routes.clientState, { ...owner, state: {} })).status).toBe(400);
    expect((await f.post(routes.hostControl, { ...owner, action: 'execute' })).status).toBe(400);
    expect((await f.post(routes.hostSend, { ...owner, messages: [42] })).status).toBe(400);
    expect((await f.poll(-1)).status).toBe(400);
    expect(f.createCall).not.toHaveBeenCalled();
  });

  it('fails closed on an event cursor gap instead of losing delegation silently', async () => {
    const f = fixture();
    await f.connect();
    for (let index = 0; index < 65; index += 1)
      await f.post(routes.clientEvent, {
        ...owner,
        event: '{"type":"input_transcript.added","item":{"text":"synthetic"}}',
      });
    expect((await f.poll()).status).toBe(503);
    expect((await f.poll(66)).status).toBe(200);
  });
  it('accepts browser failure during negotiation and retains actual closure evidence', async () => {
    const f = fixture();
    await f.prepare();
    await f.start();
    await f.post(routes.clientState, {
      ...owner,
      state: { connection: 'failed', listening: false, speaking: false, muted: false },
    });
    expect(await (await f.poll()).json()).toMatchObject({ state: 'failed' });
    expect(f.createCall).not.toHaveBeenCalled();
    expect(
      (
        await f.post(routes.clientState, {
          ...owner,
          state: { connection: 'closed', listening: false, speaking: false, muted: false },
        })
      ).status,
    ).toBe(204);
  });
});
