import { describe, expect, it } from 'vitest';
import { createVoiceMediaApi } from '../src/adapters/clientMediaApi.ts';
import {
  VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER,
  VOICE_MEDIA_ACTIVITY_EPOCH_HEADER,
  VOICE_MEDIA_ACTIVITY_LEVEL_HEADER,
  VOICE_MEDIA_ACTIVITY_SPEECH_MS_HEADER,
  VOICE_MEDIA_ACTIVITY_STATE_HEADER,
  VOICE_MEDIA_CONTENT_TYPE,
  type VoiceMediaClientEvent,
  VOICE_MEDIA_HEARTBEAT_MS,
  type VoiceMediaWake,
  VOICE_MEDIA_PROTOCOL_VERSION,
  VOICE_MEDIA_ROUTES,
} from '../src/types/clientMedia.ts';

const INTERNAL_TOKEN = 'internal-test-token';
const CLIENT_ID = 'browser-client';
const CONNECTION_ID = 'browser-connection';

function request(route: string, init: RequestInit = {}, host = false): Request {
  const headers = new Headers(init.headers);
  if (host) headers.set('authorization', `Bearer ${INTERNAL_TOKEN}`);
  return new Request(`http://voice.test${route}`, { ...init, headers });
}

function json(value: object, host = false): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(host ? { authorization: `Bearer ${INTERNAL_TOKEN}` } : {}),
    },
    body: JSON.stringify(value),
  };
}

async function connect(api: ReturnType<typeof createVoiceMediaApi>, connectionId = CONNECTION_ID): Promise<Response> {
  const response = await api.fetch(
    request(
      VOICE_MEDIA_ROUTES.clientConnect,
      json({
        version: VOICE_MEDIA_PROTOCOL_VERSION,
        clientId: CLIENT_ID,
        connectionId,
        clientKind: 'browser',
        controlLocation: 'local',
        capabilities: {
          capture: true,
          playback: true,
          captureActivity: true,
          autonomousOrchestration: true,
          playbackDucking: true,
        },
      }),
    ),
  );
  expect(response.status).toBe(200);
  return response;
}

async function nextEvent(
  api: ReturnType<typeof createVoiceMediaApi>,
  after: number,
  connectionId = CONNECTION_ID,
): Promise<VoiceMediaClientEvent> {
  const response = await api.fetch(
    request(
      `${VOICE_MEDIA_ROUTES.clientEvents}?clientId=${CLIENT_ID}&connectionId=${connectionId}&after=${String(after)}`,
    ),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as VoiceMediaClientEvent;
}

describe('voice client media session API', () => {
  it('advertises push metadata only to browser clients and seeds the broker epoch', async () => {
    const wakes: VoiceMediaWake[] = [];
    const api = createVoiceMediaApi({
      internalToken: INTERNAL_TOKEN,
      eventEpoch: 'epoch-browser',
      wakePublisher: { publish: (wake) => wakes.push(wake) },
    });

    expect(await (await connect(api)).json()).toEqual({
      version: VOICE_MEDIA_PROTOCOL_VERSION,
      cursor: 0,
      eventEpoch: 'epoch-browser',
      heartbeatMs: VOICE_MEDIA_HEARTBEAT_MS,
    });
    expect(wakes).toEqual([{ eventEpoch: 'epoch-browser', sequence: 0 }]);
    api.close();

    const native = createVoiceMediaApi({ internalToken: INTERNAL_TOKEN, eventEpoch: 'epoch-native' });
    const response = await native.fetch(
      request(
        VOICE_MEDIA_ROUTES.clientConnect,
        json({
          version: VOICE_MEDIA_PROTOCOL_VERSION,
          clientId: 'native-client',
          connectionId: 'native-connection',
          clientKind: 'native',
          controlLocation: 'local',
          capabilities: {
            capture: true,
            playback: true,
            captureActivity: false,
            autonomousOrchestration: false,
          },
        }),
      ),
    );
    expect(await response.json()).toEqual({ version: VOICE_MEDIA_PROTOCOL_VERSION, cursor: 0 });
    native.close();
  });

  it('keeps ordinary event polling blocking while wait=0 is immediate and explicit', async () => {
    const api = createVoiceMediaApi({ internalToken: INTERNAL_TOKEN, eventEpoch: 'epoch-wait' });
    await connect(api);
    let settled = false;
    const longPoll = Promise.resolve(
      api.fetch(
        request(`${VOICE_MEDIA_ROUTES.clientEvents}?clientId=${CLIENT_ID}&connectionId=${CONNECTION_ID}&after=0`),
      ),
    ).then((response) => {
      settled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    const immediate = await api.fetch(
      request(`${VOICE_MEDIA_ROUTES.clientEvents}?clientId=${CLIENT_ID}&connectionId=${CONNECTION_ID}&after=0&wait=0`),
    );
    expect(immediate.status).toBe(204);
    expect(
      (
        await api.fetch(
          request(
            `${VOICE_MEDIA_ROUTES.clientEvents}?clientId=${CLIENT_ID}&connectionId=${CONNECTION_ID}&after=0&wait=forever`,
          ),
        )
      ).status,
    ).toBe(400);

    api.close();
    expect((await longPoll).status).toBe(204);
  });

  it('heartbeats refresh the lease while only sequenced control events publish wakes', async () => {
    let now = 0;
    const wakes: VoiceMediaWake[] = [];
    const api = createVoiceMediaApi({
      internalToken: INTERNAL_TOKEN,
      eventEpoch: 'epoch-activity',
      now: () => now,
      clientConnectWaitMs: 0,
      wakePublisher: { publish: (wake) => wakes.push(wake) },
    });
    await connect(api);
    now = 10_000;
    const heartbeat = await api.fetch(
      request(VOICE_MEDIA_ROUTES.clientHeartbeat, json({ clientId: CLIENT_ID, connectionId: CONNECTION_ID })),
    );
    expect(await heartbeat.json()).toEqual({ eventEpoch: 'epoch-activity', sequence: 0 });
    now = 20_000;
    expect(
      (await api.fetch(request(VOICE_MEDIA_ROUTES.hostCaptureStart, json({ captureId: 'capture-push' }), true))).status,
    ).toBe(201);
    expect(wakes).toEqual([
      { eventEpoch: 'epoch-activity', sequence: 0 },
      { eventEpoch: 'epoch-activity', sequence: 1 },
    ]);
    expect(
      (
        await api.fetch(
          request(
            `${VOICE_MEDIA_ROUTES.clientAudio}?clientId=${CLIENT_ID}&connectionId=${CONNECTION_ID}&captureId=capture-push`,
            {
              method: 'POST',
              headers: { 'content-type': VOICE_MEDIA_CONTENT_TYPE },
              body: new Uint8Array([1, 2]),
            },
          ),
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await api.fetch(
          request(
            VOICE_MEDIA_ROUTES.clientCaptureStopped,
            json({ clientId: CLIENT_ID, connectionId: CONNECTION_ID, captureId: 'capture-push' }),
          ),
        )
      ).status,
    ).toBe(204);
    expect(wakes).toHaveLength(2);
    expect(
      (
        await api.fetch(
          request(VOICE_MEDIA_ROUTES.clientHeartbeat, json({ clientId: CLIENT_ID, connectionId: 'stale-connection' })),
        )
      ).status,
    ).toBe(409);
    api.close();
  });

  it('waits briefly for a remote media client that is still connecting', async () => {
    const api = createVoiceMediaApi({ internalToken: INTERNAL_TOKEN });
    const capture = Promise.resolve(
      api.fetch(request(VOICE_MEDIA_ROUTES.hostCaptureStart, json({ captureId: 'capture-waiting' }), true)),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    await connect(api);

    expect((await capture).status).toBe(201);
    expect(await nextEvent(api, 0)).toMatchObject({ type: 'capture-start', captureId: 'capture-waiting' });
    api.close();
  });

  it('rejects invalid media operations and publishes stop and abort events', async () => {
    const api = createVoiceMediaApi({ internalToken: INTERNAL_TOKEN, clientConnectWaitMs: 0 });

    const invalidConnect = await api.fetch(
      request(
        VOICE_MEDIA_ROUTES.clientConnect,
        json({
          version: 999,
          clientId: CLIENT_ID,
          connectionId: CONNECTION_ID,
          clientKind: 'browser',
          controlLocation: 'local',
          capabilities: { capture: true, playback: true, captureActivity: true, autonomousOrchestration: true },
        }),
      ),
    );
    expect(invalidConnect.status).toBe(400);
    expect(
      (await api.fetch(request(VOICE_MEDIA_ROUTES.hostCaptureStart, json({ captureId: 'capture-1' }), true))).status,
    ).toBe(503);
    expect(
      (
        await api.fetch(
          request(VOICE_MEDIA_ROUTES.hostPlaybackStart, json({ playbackId: 'playback-1', text: 'Unavailable.' }), true),
        )
      ).status,
    ).toBe(503);

    await connect(api);
    expect(
      (await api.fetch(request(VOICE_MEDIA_ROUTES.hostCaptureStart, json({ captureId: 'capture-1' }), true))).status,
    ).toBe(201);
    const captureStarted = await nextEvent(api, 0);
    expect(
      (await api.fetch(request(VOICE_MEDIA_ROUTES.hostCaptureStart, json({ captureId: 'capture-2' }), true))).status,
    ).toBe(409);

    const audioRoute = `${VOICE_MEDIA_ROUTES.clientAudio}?clientId=${CLIENT_ID}&connectionId=${CONNECTION_ID}&captureId=capture-1`;
    expect(
      (
        await api.fetch(
          request(
            `${VOICE_MEDIA_ROUTES.clientAudio}?clientId=wrong-client&connectionId=${CONNECTION_ID}&captureId=capture-1`,
            {
              method: 'POST',
              headers: { 'content-type': VOICE_MEDIA_CONTENT_TYPE },
              body: new Uint8Array([1, 2]),
            },
          ),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await api.fetch(
          request(
            `${VOICE_MEDIA_ROUTES.clientAudio}?clientId=${CLIENT_ID}&connectionId=${CONNECTION_ID}&captureId=wrong-capture`,
            {
              method: 'POST',
              headers: { 'content-type': VOICE_MEDIA_CONTENT_TYPE },
              body: new Uint8Array([1, 2]),
            },
          ),
        )
      ).status,
    ).toBe(409);
    expect((await api.fetch(request(audioRoute, { method: 'POST', body: new Uint8Array([1, 2]) }))).status).toBe(415);
    expect(
      (
        await api.fetch(
          request(audioRoute, {
            method: 'POST',
            headers: { 'content-type': VOICE_MEDIA_CONTENT_TYPE, 'content-length': '65537' },
            body: new Uint8Array([1, 2]),
          }),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await api.fetch(
          request(audioRoute, {
            method: 'POST',
            headers: { 'content-type': VOICE_MEDIA_CONTENT_TYPE },
            body: new Uint8Array([1]),
          }),
        )
      ).status,
    ).toBe(400);

    expect(
      (await api.fetch(request(VOICE_MEDIA_ROUTES.hostCaptureAbort, json({ captureId: 'capture-1' }), true))).status,
    ).toBe(204);
    expect(await nextEvent(api, captureStarted.sequence)).toMatchObject({
      type: 'capture-abort',
      captureId: 'capture-1',
    });
    expect(
      (
        await api.fetch(
          request(
            VOICE_MEDIA_ROUTES.clientCaptureStopped,
            json({ clientId: CLIENT_ID, connectionId: CONNECTION_ID, captureId: 'capture-1' }),
          ),
        )
      ).status,
    ).toBe(204);
    expect(
      (await api.fetch(request(`${VOICE_MEDIA_ROUTES.hostCaptureAudio}?captureId=capture-1`, {}, true))).status,
    ).toBe(410);

    expect(
      (
        await api.fetch(
          request(
            VOICE_MEDIA_ROUTES.hostPlaybackStart,
            json({ playbackId: 'playback-1', text: 'Stop in browser.' }),
            true,
          ),
        )
      ).status,
    ).toBe(201);
    const playbackStarted = await nextEvent(api, captureStarted.sequence + 1);
    expect(
      (
        await api.fetch(
          request(
            VOICE_MEDIA_ROUTES.hostPlaybackStart,
            json({ playbackId: 'playback-2', text: 'Already active.' }),
            true,
          ),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await api.fetch(
          request(
            VOICE_MEDIA_ROUTES.clientPlaybackResult,
            json({ clientId: CLIENT_ID, connectionId: CONNECTION_ID, playbackId: 'playback-1', outcome: 'invalid' }),
          ),
        )
      ).status,
    ).toBe(409);
    expect(
      (await api.fetch(request(VOICE_MEDIA_ROUTES.hostPlaybackStop, json({ playbackId: 'playback-1' }), true))).status,
    ).toBe(204);
    expect(await nextEvent(api, playbackStarted.sequence)).toMatchObject({
      type: 'playback-stop',
      playbackId: 'playback-1',
    });
    expect(
      (
        await api.fetch(
          request(
            VOICE_MEDIA_ROUTES.clientPlaybackResult,
            json({
              clientId: CLIENT_ID,
              connectionId: CONNECTION_ID,
              playbackId: 'playback-1',
              outcome: 'stopped',
              error: 'user stopped',
            }),
          ),
        )
      ).status,
    ).toBe(204);

    expect(
      (
        await api.fetch(
          request(VOICE_MEDIA_ROUTES.clientDisconnect, json({ clientId: 'wrong-client', connectionId: CONNECTION_ID })),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await api.fetch(
          request(VOICE_MEDIA_ROUTES.clientDisconnect, json({ clientId: CLIENT_ID, connectionId: CONNECTION_ID })),
        )
      ).status,
    ).toBe(204);
    api.close();
    expect((await api.fetch(request('/unknown'))).status).toBe(503);
  });

  it('returns the browser capture startup error to the host', async () => {
    const api = createVoiceMediaApi({ internalToken: INTERNAL_TOKEN });
    await connect(api);
    expect(
      (await api.fetch(request(VOICE_MEDIA_ROUTES.hostCaptureStart, json({ captureId: 'capture-error' }), true)))
        .status,
    ).toBe(201);

    const stopped = await api.fetch(
      request(
        VOICE_MEDIA_ROUTES.clientCaptureStopped,
        json({
          clientId: CLIENT_ID,
          connectionId: CONNECTION_ID,
          captureId: 'capture-error',
          error: 'NotSupportedError: AudioWorklet could not start',
        }),
      ),
    );
    expect(stopped.status).toBe(204);
    const audio = await api.fetch(request(`${VOICE_MEDIA_ROUTES.hostCaptureAudio}?captureId=capture-error`, {}, true));
    expect(audio.status).toBe(410);
    expect(await audio.json()).toEqual({ error: 'NotSupportedError: AudioWorklet could not start' });
    api.close();
  });
  it('fails active capture and playback when the client lease expires', async () => {
    let now = 0;
    const api = createVoiceMediaApi({ internalToken: INTERNAL_TOKEN, now: () => now });
    await connect(api);
    expect(
      (await api.fetch(request(VOICE_MEDIA_ROUTES.hostCaptureStart, json({ captureId: 'capture-1' }), true))).status,
    ).toBe(201);
    expect(
      (
        await api.fetch(
          request(VOICE_MEDIA_ROUTES.hostPlaybackStart, json({ playbackId: 'playback-1', text: 'Lease test.' }), true),
        )
      ).status,
    ).toBe(201);

    now = 16_000;
    expect(
      (await api.fetch(request(`${VOICE_MEDIA_ROUTES.hostCaptureAudio}?captureId=capture-1`, {}, true))).status,
    ).toBe(410);
    const playback = await api.fetch(
      request(`${VOICE_MEDIA_ROUTES.hostPlaybackResult}?playbackId=playback-1`, {}, true),
    );
    expect(await playback.json()).toEqual({
      playbackId: 'playback-1',
      outcome: 'failed',
      error: 'Voice media client lease expired.',
    });
    api.close();
  });

  it.each([
    { captureActivity: false, autonomousOrchestration: false },
    { captureActivity: true, autonomousOrchestration: false },
    { captureActivity: false, autonomousOrchestration: true },
  ])(
    'falls back to host autonomous activity control for mixed client capabilities %j',
    async ({ captureActivity, autonomousOrchestration }) => {
      const api = createVoiceMediaApi({ internalToken: INTERNAL_TOKEN });
      const connected = await api.fetch(
        request(
          VOICE_MEDIA_ROUTES.clientConnect,
          json({
            version: VOICE_MEDIA_PROTOCOL_VERSION,
            clientId: CLIENT_ID,
            connectionId: CONNECTION_ID,
            clientKind: 'native',
            controlLocation: 'local',
            capabilities: { capture: true, playback: true, captureActivity, autonomousOrchestration },
          }),
        ),
      );
      expect(connected.status).toBe(200);
      const started = await api.fetch(
        request(
          VOICE_MEDIA_ROUTES.hostCaptureStart,
          json({
            captureId: 'fallback-capture',
            configuration: { mode: 'autonomous', activityControl: 'client', endpointSilenceMs: 3_000 },
          }),
          true,
        ),
      );
      expect(started.status).toBe(201);
      expect(await nextEvent(api, 0)).toMatchObject({
        type: 'capture-start',
        configuration: { mode: 'autonomous', activityControl: 'host', endpointSilenceMs: 3_000 },
      });
      api.close();
    },
  );
  it('streams browser PCM to an authenticated host capture and drains cleanly', async () => {
    const api = createVoiceMediaApi({ internalToken: INTERNAL_TOKEN });
    await connect(api);

    expect(
      (await api.fetch(request(VOICE_MEDIA_ROUTES.hostCaptureStart, json({ captureId: 'capture-1' })))).status,
    ).toBe(404);
    expect(
      (
        await api.fetch(
          request(
            VOICE_MEDIA_ROUTES.hostCaptureStart,
            json({
              captureId: 'capture-1',
              configuration: { mode: 'autonomous', activityControl: 'client', endpointSilenceMs: 3_000 },
            }),
            true,
          ),
        )
      ).status,
    ).toBe(201);

    const started = await nextEvent(api, 0);
    expect(started).toMatchObject({
      type: 'capture-start',
      captureId: 'capture-1',
      sampleRate: 16_000,
      configuration: { mode: 'autonomous', activityControl: 'client', endpointSilenceMs: 3_000 },
    });

    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const accepted = await api.fetch(
      request(
        `${VOICE_MEDIA_ROUTES.clientAudio}?clientId=${CLIENT_ID}&connectionId=${CONNECTION_ID}&captureId=capture-1`,
        {
          method: 'POST',
          headers: {
            'content-type': VOICE_MEDIA_CONTENT_TYPE,
            [VOICE_MEDIA_ACTIVITY_STATE_HEADER]: 'speech',
            [VOICE_MEDIA_ACTIVITY_LEVEL_HEADER]: '-41.5',
            [VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER]: '700',
            [VOICE_MEDIA_ACTIVITY_EPOCH_HEADER]: '2',
            [VOICE_MEDIA_ACTIVITY_SPEECH_MS_HEADER]: '640',
          },
          body: pcm,
        },
      ),
    );
    expect(accepted.status).toBe(204);

    const audio = await api.fetch(request(`${VOICE_MEDIA_ROUTES.hostCaptureAudio}?captureId=capture-1`, {}, true));
    expect(audio.status).toBe(200);
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(pcm);
    expect(audio.headers.get(VOICE_MEDIA_ACTIVITY_STATE_HEADER)).toBe('speech');
    expect(audio.headers.get(VOICE_MEDIA_ACTIVITY_LEVEL_HEADER)).toBe('-41.5');
    expect(audio.headers.get(VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER)).toBe('700');
    expect(audio.headers.get(VOICE_MEDIA_ACTIVITY_EPOCH_HEADER)).toBe('2');
    expect(audio.headers.get(VOICE_MEDIA_ACTIVITY_SPEECH_MS_HEADER)).toBe('640');

    expect(
      (await api.fetch(request(VOICE_MEDIA_ROUTES.hostCaptureStop, json({ captureId: 'capture-1' }), true))).status,
    ).toBe(204);
    expect(await nextEvent(api, started.sequence)).toMatchObject({ type: 'capture-stop', captureId: 'capture-1' });
    expect(
      (
        await api.fetch(
          request(
            VOICE_MEDIA_ROUTES.clientCaptureStopped,
            json({ clientId: CLIENT_ID, connectionId: CONNECTION_ID, captureId: 'capture-1' }),
          ),
        )
      ).status,
    ).toBe(204);
    const drained = await api.fetch(request(`${VOICE_MEDIA_ROUTES.hostCaptureAudio}?captureId=capture-1`, {}, true));
    expect(drained.status).toBe(204);
    expect(drained.headers.get('x-doompi-capture-state')).toBe('stopped');
    api.close();
  });

  it('preserves queued speech and endpoint transitions in separate host reads', async () => {
    const api = createVoiceMediaApi({ internalToken: INTERNAL_TOKEN });
    await connect(api);
    expect(
      (
        await api.fetch(
          request(
            VOICE_MEDIA_ROUTES.hostCaptureStart,
            json({
              captureId: 'capture-transitions',
              configuration: { mode: 'autonomous', activityControl: 'client', endpointSilenceMs: 600 },
            }),
            true,
          ),
        )
      ).status,
    ).toBe(201);
    const audioRoute = `${VOICE_MEDIA_ROUTES.clientAudio}?clientId=${CLIENT_ID}&connectionId=${CONNECTION_ID}&captureId=capture-transitions`;
    const upload = (state: 'speech' | 'endpoint', elapsedMs: number, pcm: Uint8Array): Promise<Response> =>
      Promise.resolve(
        api.fetch(
          request(audioRoute, {
            method: 'POST',
            headers: {
              'content-type': VOICE_MEDIA_CONTENT_TYPE,
              [VOICE_MEDIA_ACTIVITY_STATE_HEADER]: state,
              [VOICE_MEDIA_ACTIVITY_LEVEL_HEADER]: state === 'speech' ? '-35' : '-80',
              [VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER]: String(elapsedMs),
            },
            body: pcm,
          }),
        ),
      );
    const speechPcm = new Uint8Array([1, 2]);
    const endpointPcm = new Uint8Array([3, 4]);
    expect((await upload('speech', 500, speechPcm)).status).toBe(204);
    expect((await upload('endpoint', 1_100, endpointPcm)).status).toBe(204);

    const speech = await api.fetch(
      request(`${VOICE_MEDIA_ROUTES.hostCaptureAudio}?captureId=capture-transitions`, {}, true),
    );
    const endpoint = await api.fetch(
      request(`${VOICE_MEDIA_ROUTES.hostCaptureAudio}?captureId=capture-transitions`, {}, true),
    );
    expect(new Uint8Array(await speech.arrayBuffer())).toEqual(speechPcm);
    expect(speech.headers.get(VOICE_MEDIA_ACTIVITY_STATE_HEADER)).toBe('speech');
    expect(new Uint8Array(await endpoint.arrayBuffer())).toEqual(endpointPcm);
    expect(endpoint.headers.get(VOICE_MEDIA_ACTIVITY_STATE_HEADER)).toBe('endpoint');
    api.close();
  });

  it('delivers narration to the client and returns physical playback settlement', async () => {
    const api = createVoiceMediaApi({ internalToken: INTERNAL_TOKEN });
    await connect(api);

    const startedResponse = await api.fetch(
      request(
        VOICE_MEDIA_ROUTES.hostPlaybackStart,
        json({ playbackId: 'playback-1', text: 'Narrate in the browser.', voice: 'Samantha', rate: 190 }),
        true,
      ),
    );
    expect(startedResponse.status).toBe(201);
    expect(await nextEvent(api, 0)).toMatchObject({
      type: 'playback-start',
      playbackId: 'playback-1',
      text: 'Narrate in the browser.',
    });

    const finished = await api.fetch(
      request(
        VOICE_MEDIA_ROUTES.clientPlaybackResult,
        json({ clientId: CLIENT_ID, connectionId: CONNECTION_ID, playbackId: 'playback-1', outcome: 'completed' }),
      ),
    );
    expect(finished.status).toBe(204);
    const result = await api.fetch(request(`${VOICE_MEDIA_ROUTES.hostPlaybackResult}?playbackId=playback-1`, {}, true));
    expect(await result.json()).toEqual({ playbackId: 'playback-1', outcome: 'completed' });
    api.close();
  });

  it('leases a session to one media client at a time', async () => {
    const api = createVoiceMediaApi({ internalToken: INTERNAL_TOKEN });
    await connect(api);
    const conflict = await api.fetch(
      request(
        VOICE_MEDIA_ROUTES.clientConnect,
        json({
          version: VOICE_MEDIA_PROTOCOL_VERSION,
          clientId: 'another-browser',
          connectionId: 'another-connection',
          clientKind: 'browser',
          controlLocation: 'local',
          capabilities: { capture: true, playback: true, captureActivity: true, autonomousOrchestration: true },
        }),
      ),
    );
    expect(conflict.status).toBe(409);
    api.close();
  });

  it('hands the media lease to a remote controller and keeps local clients from taking it back', async () => {
    const api = createVoiceMediaApi({ internalToken: INTERNAL_TOKEN });
    await connect(api);
    expect(
      (
        await api.fetch(
          request(
            VOICE_MEDIA_ROUTES.hostPlaybackStart,
            json({ playbackId: 'playback-local', text: 'Move this narration to the remote client.' }),
            true,
          ),
        )
      ).status,
    ).toBe(201);

    const remoteConnect = await api.fetch(
      request(
        VOICE_MEDIA_ROUTES.clientConnect,
        json({
          version: VOICE_MEDIA_PROTOCOL_VERSION,
          clientId: 'remote-browser',
          connectionId: 'remote-connection',
          clientKind: 'browser',
          controlLocation: 'remote',
          capabilities: { capture: true, playback: true, captureActivity: true, autonomousOrchestration: true },
        }),
      ),
    );
    expect(remoteConnect.status).toBe(200);
    const remoteCursor = (await remoteConnect.json()) as { cursor: number };

    const localReconnect = await api.fetch(
      request(
        VOICE_MEDIA_ROUTES.clientConnect,
        json({
          version: VOICE_MEDIA_PROTOCOL_VERSION,
          clientId: 'local-browser-2',
          connectionId: 'local-connection-2',
          clientKind: 'browser',
          controlLocation: 'local',
          capabilities: { capture: true, playback: true, captureActivity: true, autonomousOrchestration: true },
        }),
      ),
    );
    expect(localReconnect.status).toBe(409);
    const displaced = await api.fetch(
      request(`${VOICE_MEDIA_ROUTES.hostPlaybackResult}?playbackId=playback-local`, {}, true),
    );
    expect(await displaced.json()).toMatchObject({ outcome: 'failed' });

    expect(
      (
        await api.fetch(
          request(
            VOICE_MEDIA_ROUTES.hostPlaybackStart,
            json({ playbackId: 'playback-remote', text: 'Narrate beside the user.' }),
            true,
          ),
        )
      ).status,
    ).toBe(201);
    const remoteEvent = await api.fetch(
      request(
        `${VOICE_MEDIA_ROUTES.clientEvents}?clientId=remote-browser&connectionId=remote-connection&after=${String(remoteCursor.cursor)}`,
      ),
    );
    expect(await remoteEvent.json()).toMatchObject({ type: 'playback-start', playbackId: 'playback-remote' });
    api.close();
  });
  it('lets one browser tab replace its stale runtime without accepting stale cleanup', async () => {
    const api = createVoiceMediaApi({ internalToken: INTERNAL_TOKEN });
    const replacementConnectionId = 'replacement-connection';
    await connect(api);

    await connect(api, replacementConnectionId);
    const staleDisconnect = await api.fetch(
      request(VOICE_MEDIA_ROUTES.clientDisconnect, json({ clientId: CLIENT_ID, connectionId: CONNECTION_ID })),
    );
    expect(staleDisconnect.status).toBe(409);

    expect(
      (await api.fetch(request(VOICE_MEDIA_ROUTES.hostCaptureStart, json({ captureId: 'capture-1' }), true))).status,
    ).toBe(201);
    expect(await nextEvent(api, 0, replacementConnectionId)).toMatchObject({
      type: 'capture-start',
      captureId: 'capture-1',
    });
    const stalePoll = await api.fetch(
      request(`${VOICE_MEDIA_ROUTES.clientEvents}?clientId=${CLIENT_ID}&connectionId=${CONNECTION_ID}&after=0`),
    );
    expect(stalePoll.status).toBe(409);
    api.close();
  });

  it('does not forward reordered client activity while preserving its PCM', async () => {
    const api = createVoiceMediaApi({ internalToken: INTERNAL_TOKEN });
    await connect(api);
    const started = await api.fetch(
      request(
        VOICE_MEDIA_ROUTES.hostCaptureStart,
        json({
          captureId: 'capture-ordered',
          configuration: { mode: 'autonomous', activityControl: 'client', endpointSilenceMs: 600 },
        }),
        true,
      ),
    );
    expect(started.status).toBe(201);

    const audioRoute = `${VOICE_MEDIA_ROUTES.clientAudio}?clientId=${CLIENT_ID}&connectionId=${CONNECTION_ID}&captureId=capture-ordered`;
    const send = (
      state: 'listening' | 'speech' | 'endpoint',
      elapsedMs: number,
      epoch = 0,
      classifiedSpeechMs = 0,
    ): Promise<Response> =>
      Promise.resolve(
        api.fetch(
          request(audioRoute, {
            method: 'POST',
            headers: {
              'content-type': VOICE_MEDIA_CONTENT_TYPE,
              [VOICE_MEDIA_ACTIVITY_STATE_HEADER]: state,
              [VOICE_MEDIA_ACTIVITY_LEVEL_HEADER]: '-41',
              [VOICE_MEDIA_ACTIVITY_ELAPSED_HEADER]: String(elapsedMs),
              [VOICE_MEDIA_ACTIVITY_EPOCH_HEADER]: String(epoch),
              [VOICE_MEDIA_ACTIVITY_SPEECH_MS_HEADER]: String(classifiedSpeechMs),
            },
            body: new Uint8Array([1, 2]),
          }),
        ),
      );

    expect((await send('speech', 500, 0, 160)).status).toBe(204);
    const speech = await api.fetch(
      request(`${VOICE_MEDIA_ROUTES.hostCaptureAudio}?captureId=capture-ordered`, {}, true),
    );
    expect(speech.headers.get(VOICE_MEDIA_ACTIVITY_STATE_HEADER)).toBe('speech');
    expect(speech.headers.get(VOICE_MEDIA_ACTIVITY_EPOCH_HEADER)).toBe('0');
    expect(speech.headers.get(VOICE_MEDIA_ACTIVITY_SPEECH_MS_HEADER)).toBe('160');

    expect((await send('endpoint', 400, 0, 160)).status).toBe(204);
    const reordered = await api.fetch(
      request(`${VOICE_MEDIA_ROUTES.hostCaptureAudio}?captureId=capture-ordered`, {}, true),
    );
    expect(new Uint8Array(await reordered.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
    expect(reordered.headers.get(VOICE_MEDIA_ACTIVITY_STATE_HEADER)).toBeNull();

    expect((await send('listening', 600, 1)).status).toBe(204);
    const reset = await api.fetch(
      request(`${VOICE_MEDIA_ROUTES.hostCaptureAudio}?captureId=capture-ordered`, {}, true),
    );
    expect(reset.headers.get(VOICE_MEDIA_ACTIVITY_STATE_HEADER)).toBe('listening');
    expect(reset.headers.get(VOICE_MEDIA_ACTIVITY_EPOCH_HEADER)).toBe('1');
    expect(reset.headers.get(VOICE_MEDIA_ACTIVITY_SPEECH_MS_HEADER)).toBe('0');
    api.close();
  });

  it('bounds reconnect recovery to a new capture and rejects stale capture uploads', async () => {
    const api = createVoiceMediaApi({ internalToken: INTERNAL_TOKEN });
    await connect(api);
    expect(
      (await api.fetch(request(VOICE_MEDIA_ROUTES.hostCaptureStart, json({ captureId: 'capture-before' }), true)))
        .status,
    ).toBe(201);

    await connect(api, 'replacement-connection');
    expect(
      (await api.fetch(request(`${VOICE_MEDIA_ROUTES.hostCaptureAudio}?captureId=capture-before`, {}, true))).status,
    ).toBe(410);
    expect(
      (await api.fetch(request(VOICE_MEDIA_ROUTES.hostCaptureStart, json({ captureId: 'capture-after' }), true)))
        .status,
    ).toBe(201);

    const staleUpload = await api.fetch(
      request(
        `${VOICE_MEDIA_ROUTES.clientAudio}?clientId=${CLIENT_ID}&connectionId=replacement-connection&captureId=capture-before`,
        {
          method: 'POST',
          headers: { 'content-type': VOICE_MEDIA_CONTENT_TYPE },
          body: new Uint8Array([1, 2]),
        },
      ),
    );
    expect(staleUpload.status).toBe(409);
    const current = await api.fetch(
      request(`${VOICE_MEDIA_ROUTES.hostCaptureAudio}?captureId=capture-after`, {}, true),
    );
    expect(current.headers.get(VOICE_MEDIA_ACTIVITY_STATE_HEADER)).toBeNull();
    api.close();
  });
});
