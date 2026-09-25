import { describe, expect, it, vi } from 'vitest';

import { VoiceMediaBroker } from '../src/services/clientMediaApi';
import {
  VOICE_MEDIA_EVENT_WAIT_NONE,
  VOICE_MEDIA_PROTOCOL_VERSION,
  VOICE_MEDIA_ROUTES,
} from '../src/types/clientMedia';
import { REALTIME_ROUTES } from '../src/types/realtime';

function post(path: string, value: object): Request {
  return new Request(`http://voice.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}

function fixture() {
  let ready = false;
  const createCall = vi.fn(async () => ({ sdp: 'answer', callId: 'one-call' }));
  const broker = new VoiceMediaBroker({
    globalLive: { ready: () => ready },
    sessionId: 'global-live-companion',
    realtimeProvider: { createCall },
    clientConnectWaitMs: 0,
  });
  const client = { clientId: 'browser', connectionId: 'connection' };
  const connect = () =>
    broker.fetch(
      post(VOICE_MEDIA_ROUTES.clientConnect, {
        ...client,
        version: VOICE_MEDIA_PROTOCOL_VERSION,
        clientKind: 'browser',
        controlLocation: 'remote',
        capabilities: {
          capture: false,
          playback: false,
          captureActivity: false,
          autonomousOrchestration: false,
          realtime: true,
        },
      }),
    );
  return { broker, client, connect, createCall, setReady: (value: boolean) => (ready = value) };
}

describe('global live media lease', () => {
  it('allows preactivation browser lease without granting capture or requesting microphone/provider', async () => {
    const { broker, client, connect, createCall, setReady } = fixture();
    expect((await connect()).status).toBe(200);
    expect(broker.browserConnected).toBe(true);
    expect(createCall).not.toHaveBeenCalled();
    expect((await broker.fetch(post(VOICE_MEDIA_ROUTES.hostCaptureStart, { captureId: 'capture' }))).status).toBe(404);
    expect((await broker.fetch(post(VOICE_MEDIA_ROUTES.clientAudio, client))).status).toBe(404);
    await expect(broker.live.start('activation', 'instruction', new AbortController().signal)).rejects.toThrow();
    setReady(true);
    await broker.live.start('activation', 'instruction', new AbortController().signal);
    const event = await broker.fetch(
      new Request(
        `http://voice.test${VOICE_MEDIA_ROUTES.clientEvents}?clientId=${client.clientId}&connectionId=${client.connectionId}&after=0&wait=${VOICE_MEDIA_EVENT_WAIT_NONE}`,
      ),
    );
    expect((await event.json()) as object).toMatchObject({ type: 'realtime-start', activationId: 'activation' });
    expect(createCall).not.toHaveBeenCalled();
    const negotiate = await broker.fetch(
      post(REALTIME_ROUTES.clientNegotiate, { ...client, activationId: 'activation', sdp: 'offer' }),
    );
    expect(negotiate.status).toBe(200);
    expect(createCall).toHaveBeenCalledOnce();
    broker.close();
  });

  it('retains the same activation across agent-route changes and closes on genuine loss of route or lease', async () => {
    const { broker, client, connect, createCall, setReady } = fixture();
    await connect();
    setReady(true);
    await broker.live.start('activation', 'instruction', new AbortController().signal);
    await broker.fetch(post(REALTIME_ROUTES.clientNegotiate, { ...client, activationId: 'activation', sdp: 'offer' }));
    await broker.fetch(
      post(REALTIME_ROUTES.clientState, {
        ...client,
        activationId: 'activation',
        state: { connection: 'connected', speaking: false, listening: true, muted: false },
      }),
    );
    // Neither the browser lease nor its realtime call is tied to the selected Pi agent.
    expect((await connect()).status).toBe(200);
    expect(broker.realtimeActive).toBe(true);
    expect(createCall).toHaveBeenCalledOnce();
    setReady(false);
    expect(broker.realtimeActive).toBe(false);
    await expect(broker.live.start('activation', 'instruction', new AbortController().signal)).rejects.toThrow();
    broker.close();
  });
});
