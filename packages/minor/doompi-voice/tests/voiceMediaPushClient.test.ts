import { bindSessionApiWorkspace } from '@agimon-ai/doompi-core/web';
import { beforeEach as beforeEachApiRoutes } from 'vitest';
beforeEachApiRoutes(() => bindSessionApiWorkspace(() => 'test-workspace'));
import { driveChannel } from '@agimon-ai/doompi-core/webTesting';
import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseVoiceMediaWakePayload,
  voiceMediaWakeChannel,
  voiceMediaWakes,
} from '../src/extensions/workspaces/sessions/(frontend)/_lib/voiceMediaWakeStore';
import { BrowserVoiceMediaTransport } from '../src/extensions/workspaces/sessions/(frontend)/lifecycle/_lib/clientMediaTransport';
import { VOICE_MEDIA_ACTIVITY_ECHO_SPEECH_MS_HEADER, type VoiceMediaClientEvent } from '../src/types/clientMedia';
import { REALTIME_ROUTES } from '../src/types/realtime';

vi.mock('@agimon-ai/doompi-web-security/browser', () => ({
  sealedTransport: {
    active: vi.fn(() => false),
    fetch: vi.fn(),
  },
}));

const capabilities = {
  capture: true,
  playback: true,
  captureActivity: true,
  autonomousOrchestration: true,
  playbackDucking: true,
} as const;

function jsonResponse(value: object, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function captureEvent(sequence: number): VoiceMediaClientEvent {
  return {
    sequence,
    type: 'capture-start',
    captureId: `capture-${String(sequence)}`,
    sampleRate: 16_000,
    channels: 1,
    bitsPerSample: 16,
    configuration: { mode: 'manual', activityControl: 'host' },
  };
}

function requestUrl(call: readonly unknown[]): string {
  return String(call[0]);
}

afterEach(() => {
  voiceMediaWakes.reset();
  vi.clearAllMocks();
  vi.mocked(sealedTransport.active).mockReturnValue(false);
});

describe('browser voice media push transport', () => {
  it('uses only the global lease and long poll for live media without session PCM or wake routing', async () => {
    vi.mocked(sealedTransport.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/client/connect'))
        return jsonResponse({ version: 6, cursor: 0, eventEpoch: 'global-epoch', heartbeatMs: 15_000 });
      if (url.includes('/client/events'))
        return jsonResponse({ sequence: 1, type: 'realtime-start', activationId: 'activation' });
      if (url.endsWith('/client/realtime/negotiate')) return jsonResponse({ sdp: 'answer' });
      if (url.endsWith('/client/realtime/event') || url.endsWith('/client/realtime/state') || url.endsWith('/client/disconnect'))
        return new Response(null, { status: 204 });
      throw new Error(`Unexpected global live media request: ${url}`);
    });
    const transport = new BrowserVoiceMediaTransport(null);
    await transport.connect('browser', 'lease', { ...capabilities, realtime: true });
    expect(await transport.nextEvent('browser', 'lease', 0, new AbortController().signal)).toEqual({
      sequence: 1,
      type: 'realtime-start',
      activationId: 'activation',
    });
    expect(await transport.realtimeNegotiate('browser', 'lease', 'activation', 'offer', new AbortController().signal))
      .toBe('answer');
    await transport.realtimeEvent('browser', 'lease', 'activation', '{"type":"session.update"}');
    await transport.realtimeState('browser', 'lease', 'activation', {
      connection: 'connected', listening: true, speaking: false, muted: false,
    });
    await expect(transport.sendAudio('browser', 'lease', 'capture', new Uint8Array([1]))).rejects.toThrow('session-scoped');
    await transport.disconnect('browser', 'lease');
    const urls = vi.mocked(sealedTransport.fetch).mock.calls.map(requestUrl);
    expect(urls).toHaveLength(6);
    expect(urls.every((url) => url.startsWith('/api/plugins/voice-media/'))).toBe(true);
    expect(urls.find((url) => url.includes('/client/events'))).not.toContain('wait=0');
    expect(urls.some((url) => url.includes('/client/heartbeat'))).toBe(false);
  });

  it.each([
    { sealed: false, location: 'local' },
    { sealed: true, location: 'remote' },
  ])('uses wake-driven wait=0 event fetches for $location browsers', async ({ sealed, location }) => {
    vi.mocked(sealedTransport.active).mockReturnValue(sealed);
    vi.mocked(sealedTransport.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/client/connect')) {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON connect body.');
        expect(JSON.parse(init.body)).toMatchObject({ clientKind: 'browser', controlLocation: location });
        return jsonResponse({ version: 5, cursor: 0, eventEpoch: `epoch-${location}`, heartbeatMs: 1_000 });
      }
      if (url.includes('/client/events')) return jsonResponse(captureEvent(1));
      throw new Error(`Unexpected voice request: ${url}`);
    });

    const sessionId = `session-${location}`;
    const transport = new BrowserVoiceMediaTransport(sessionId);
    await transport.connect('client', 'connection', capabilities);
    const next = transport.nextEvent('client', 'connection', 0, new AbortController().signal);
    expect(driveChannel(voiceMediaWakeChannel, sessionId, { eventEpoch: `epoch-${location}`, sequence: 1 })).toEqual({
      accepted: true,
    });
    expect(await next).toEqual(captureEvent(1));

    const eventCall = vi
      .mocked(sealedTransport.fetch)
      .mock.calls.find((call) => requestUrl(call).includes('/client/events'));
    expect(requestUrl(eventCall ?? [])).toContain('wait=0');
  });

  it('refreshes capabilities without replacing push state, control location, or event position', async () => {
    let declarations = 0;
    vi.mocked(sealedTransport.active).mockReturnValue(false);
    vi.mocked(sealedTransport.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/client/connect')) {
        if (typeof init?.body !== 'string') throw new Error('Expected a JSON connect body.');
        const body = JSON.parse(init.body) as { controlLocation: string; capabilities: typeof capabilities };
        expect(body.controlLocation).toBe('local');
        declarations += 1;
        if (declarations === 2) expect(body.capabilities.captureActivity).toBe(true);
        return jsonResponse({
          version: 5,
          cursor: declarations === 1 ? 0 : 99,
          eventEpoch: declarations === 1 ? 'epoch-stable' : 'epoch-ignored',
          heartbeatMs: 1_000,
        });
      }
      if (url.includes('/client/events')) return jsonResponse(captureEvent(1));
      throw new Error(`Unexpected voice request: ${url}`);
    });
    const transport = new BrowserVoiceMediaTransport('session-refresh');
    await transport.connect('client', 'connection', {
      ...capabilities,
      captureActivity: false,
      autonomousOrchestration: false,
    });

    vi.mocked(sealedTransport.active).mockReturnValue(true);
    await transport.refreshCapabilities('client', 'connection', capabilities);
    const next = transport.nextEvent('client', 'connection', 0, new AbortController().signal);
    driveChannel(voiceMediaWakeChannel, 'session-refresh', { eventEpoch: 'epoch-stable', sequence: 1 });

    expect(await next).toEqual(captureEvent(1));
    expect(declarations).toBe(2);
    const eventCall = vi
      .mocked(sealedTransport.fetch)
      .mock.calls.find((call) => requestUrl(call).includes('/client/events'));
    expect(requestUrl(eventCall ?? [])).toContain('wait=0');
  });

  it.each([
    { eventEpoch: '', heartbeatMs: 1_000 },
    { eventEpoch: 'x'.repeat(201), heartbeatMs: 1_000 },
    { eventEpoch: 'epoch', heartbeatMs: undefined },
    { eventEpoch: 'epoch', heartbeatMs: 1.5 },
    { eventEpoch: 'epoch', heartbeatMs: 60_001 },
  ])('falls back to the existing long poll for incompatible metadata %#', async (metadata) => {
    vi.mocked(sealedTransport.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/client/connect')) return jsonResponse({ version: 5, cursor: 0, ...metadata });
      if (url.includes('/client/events')) return jsonResponse(captureEvent(1));
      throw new Error(`Unexpected voice request: ${url}`);
    });
    const transport = new BrowserVoiceMediaTransport('session-fallback');
    await transport.connect('client', 'connection', capabilities);

    expect(await transport.nextEvent('client', 'connection', 0, new AbortController().signal)).toEqual(captureEvent(1));
    const eventCall = vi
      .mocked(sealedTransport.fetch)
      .mock.calls.find((call) => requestUrl(call).includes('/client/events'));
    expect(requestUrl(eventCall ?? [])).not.toContain('wait=');
  });

  it('strictly validates wake payloads and retains only each epoch high-water mark', () => {
    expect(parseVoiceMediaWakePayload({ eventEpoch: 'epoch', sequence: 0 })).toEqual({
      eventEpoch: 'epoch',
      sequence: 0,
    });
    for (const invalid of [
      null,
      [],
      { eventEpoch: 'epoch', sequence: 0, clientId: 'secret' },
      { eventEpoch: 'x'.repeat(201), sequence: 0 },
      { eventEpoch: 'epoch', sequence: Number.NaN },
      { eventEpoch: 'epoch', sequence: -1 },
    ]) {
      expect(parseVoiceMediaWakePayload(invalid)).toBeNull();
    }

    driveChannel(voiceMediaWakeChannel, 'session-reduce', { eventEpoch: 'epoch', sequence: 2 });
    const highWater = voiceMediaWakes.select(voiceMediaWakes.store.state, 'session-reduce');
    driveChannel(voiceMediaWakeChannel, 'session-reduce', { eventEpoch: 'epoch', sequence: 1 });
    expect(voiceMediaWakes.select(voiceMediaWakes.store.state, 'session-reduce')).toBe(highWater);
    driveChannel(voiceMediaWakeChannel, 'session-reduce', { eventEpoch: 'replacement', sequence: 0 });
    expect(voiceMediaWakes.select(voiceMediaWakes.store.state, 'session-reduce')).toEqual({
      eventEpoch: 'replacement',
      sequence: 0,
    });
  });

  it('recovers missed wakes through heartbeat and then performs a nonblocking fetch', async () => {
    vi.mocked(sealedTransport.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/client/connect')) {
        return jsonResponse({ version: 5, cursor: 0, eventEpoch: 'epoch-heartbeat', heartbeatMs: 5 });
      }
      if (url.includes('/client/heartbeat')) return jsonResponse({ eventEpoch: 'epoch-heartbeat', sequence: 1 });
      if (url.includes('/client/events')) return jsonResponse(captureEvent(1));
      throw new Error(`Unexpected voice request: ${url}`);
    });
    const transport = new BrowserVoiceMediaTransport('session-heartbeat');
    await transport.connect('client', 'connection', capabilities);

    expect(await transport.nextEvent('client', 'connection', 0, new AbortController().signal)).toEqual(captureEvent(1));
    const urls = vi.mocked(sealedTransport.fetch).mock.calls.map(requestUrl);
    expect(urls.some((url) => url.includes('/client/heartbeat'))).toBe(true);
    expect(urls.find((url) => url.includes('/client/events'))).toContain('wait=0');
  });

  it('uses a coalesced high-water wake to drain authoritative events in order', async () => {
    const events = [captureEvent(1), captureEvent(2)];
    vi.mocked(sealedTransport.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/client/connect')) {
        return jsonResponse({ version: 5, cursor: 0, eventEpoch: 'epoch-coalesced', heartbeatMs: 1_000 });
      }
      if (url.includes('/client/events')) return jsonResponse(events.shift() ?? captureEvent(99));
      throw new Error(`Unexpected voice request: ${url}`);
    });
    const transport = new BrowserVoiceMediaTransport('session-coalesced');
    await transport.connect('client', 'connection', capabilities);
    driveChannel(voiceMediaWakeChannel, 'session-coalesced', { eventEpoch: 'epoch-coalesced', sequence: 2 });

    expect(await transport.nextEvent('client', 'connection', 0, new AbortController().signal)).toEqual(captureEvent(1));
    expect(await transport.nextEvent('client', 'connection', 1, new AbortController().signal)).toEqual(captureEvent(2));
  });

  it('rejects a wake that no longer resolves to authoritative event history', async () => {
    vi.mocked(sealedTransport.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/client/connect')) {
        return jsonResponse({ version: 5, cursor: 0, eventEpoch: 'epoch-missing', heartbeatMs: 1_000 });
      }
      if (url.includes('/client/events')) return new Response(null, { status: 204 });
      throw new Error(`Unexpected voice request: ${url}`);
    });
    const transport = new BrowserVoiceMediaTransport('session-missing');
    await transport.connect('client', 'connection', capabilities);
    driveChannel(voiceMediaWakeChannel, 'session-missing', { eventEpoch: 'epoch-missing', sequence: 1 });

    await expect(transport.nextEvent('client', 'connection', 0, new AbortController().signal)).rejects.toThrow(
      'Voice media wake could not be resolved.',
    );
  });

  it('uploads media and acknowledgements with every optional activity branch', async () => {
    vi.mocked(sealedTransport.fetch).mockResolvedValue(new Response(null, { status: 204 }));
    const transport = new BrowserVoiceMediaTransport('session-operations');

    await transport.sendAudio('client', 'connection', 'capture', new Uint8Array([1]));
    await transport.sendAudio('client', 'connection', 'capture', new Uint8Array([2]), {
      state: 'listening',
      levelDbfs: -20,
      elapsedMs: 40,
    });
    await transport.sendAudio('client', 'connection', 'capture', new Uint8Array([3]), {
      state: 'endpoint',
      levelDbfs: -10,
      elapsedMs: 80,
      epoch: 2,
      classifiedSpeechMs: 60,
      echoDiscriminatedSpeechMs: 40,
    });
    await transport.captureStopped('client', 'connection', 'capture');
    await transport.captureStopped('client', 'connection', 'capture', 'device failed');
    await transport.playbackFinished('client', 'connection', {
      playbackId: 'playback',
      outcome: 'completed',
    });

    vi.mocked(sealedTransport.fetch).mockResolvedValueOnce(new Response(null, { status: 409 }));
    await expect(transport.disconnect('client', 'connection')).resolves.toBeUndefined();
    expect(vi.mocked(sealedTransport.fetch)).toHaveBeenCalledTimes(7);
    const uploadHeaders = new Headers(vi.mocked(sealedTransport.fetch).mock.calls[2]?.[1]?.headers);
    expect(uploadHeaders.get(VOICE_MEDIA_ACTIVITY_ECHO_SPEECH_MS_HEADER)).toBe('40');
  });

  it('reports server JSON errors and response bodies without usable errors', async () => {
    const transport = new BrowserVoiceMediaTransport('session-errors');
    vi.mocked(sealedTransport.fetch).mockResolvedValueOnce(jsonResponse({ error: 'lease denied' }, 409));
    await expect(transport.connect('client', 'connection', capabilities)).rejects.toThrow('lease denied');

    vi.mocked(sealedTransport.fetch).mockResolvedValueOnce(jsonResponse({ error: 42 }, 500));
    await expect(transport.connect('client', 'connection', capabilities)).rejects.toThrow('status 500');

    vi.mocked(sealedTransport.fetch).mockResolvedValueOnce(new Response('not json', { status: 503 }));
    await expect(transport.connect('client', 'connection', capabilities)).rejects.toThrow('status 503');
  });

  it('rejects broker epoch replacement and aborts pending waits without fetching events', async () => {
    vi.mocked(sealedTransport.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/client/connect')) {
        return jsonResponse({ version: 5, cursor: 0, eventEpoch: 'epoch-before', heartbeatMs: 5 });
      }
      if (url.includes('/client/heartbeat')) return jsonResponse({ eventEpoch: 'epoch-after', sequence: 0 });
      throw new Error(`Unexpected voice request: ${url}`);
    });
    const replaced = new BrowserVoiceMediaTransport('session-replaced');
    await replaced.connect('client', 'connection', capabilities);
    await expect(replaced.nextEvent('client', 'connection', 0, new AbortController().signal)).rejects.toThrow(
      'Voice media broker changed.',
    );

    vi.mocked(sealedTransport.fetch).mockReset();
    vi.mocked(sealedTransport.fetch).mockResolvedValueOnce(
      jsonResponse({ version: 5, cursor: 0, eventEpoch: 'epoch-abort', heartbeatMs: 1_000 }),
    );
    const aborted = new BrowserVoiceMediaTransport('session-abort');
    await aborted.connect('client', 'connection', capabilities);
    const controller = new AbortController();
    const waiting = aborted.nextEvent('client', 'connection', 0, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
    expect(vi.mocked(sealedTransport.fetch)).toHaveBeenCalledOnce();
  });

  it('posts realtime negotiation, provider events, and browser state through sealed transport', async () => {
    vi.mocked(sealedTransport.fetch)
      .mockResolvedValueOnce(jsonResponse({ sdp: 'answer-sdp' }))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const transport = new BrowserVoiceMediaTransport('session-realtime');
    const controller = new AbortController();

    await expect(
      transport.realtimeNegotiate('client', 'connection', 'activation', 'offer-sdp', controller.signal),
    ).resolves.toBe('answer-sdp');
    await transport.realtimeEvent('client', 'connection', 'activation', '{"type":"ready"}');
    await transport.realtimeState('client', 'connection', 'activation', {
      connection: 'connected',
      listening: true,
      speaking: false,
      muted: false,
    });

    const calls = vi.mocked(sealedTransport.fetch).mock.calls;
    expect(requestUrl(calls[0] ?? [])).toContain(REALTIME_ROUTES.clientNegotiate);
    expect(requestUrl(calls[1] ?? [])).toContain(REALTIME_ROUTES.clientEvent);
    expect(requestUrl(calls[2] ?? [])).toContain(REALTIME_ROUTES.clientState);
    expect(JSON.parse(calls[0]?.[1]?.body as string)).toEqual({
      clientId: 'client',
      connectionId: 'connection',
      activationId: 'activation',
      sdp: 'offer-sdp',
    });
    expect(calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it('keeps paired-host media on the declared home-host relay', async () => {
    const relayed: Array<{ path: string; method: string; body: string }> = [];
    let playbackPoll = 0;
    vi.mocked(sealedTransport.fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON relay body.');
      if (url.includes('/voice/relay-binding')) {
        expect(JSON.parse(init.body)).toEqual({
          target: 'peer/work-host/voice-session',
          connectionId: 'connection',
        });
        return jsonResponse({ binding: 'opaque-binding', expiresAt: Date.now() + 300_000 });
      }
      expect(url).toContain('/voice/relay');
      expect(url).toContain('binding=opaque-binding');
      expect(url).not.toContain('work-host');
      const envelope = JSON.parse(init.body) as { path: string; method: string; body: string };
      relayed.push(envelope);
      if (envelope.path.includes('/client/connect')) {
        return jsonResponse({
          status: 200,
          headers: [['content-type', 'application/json']],
          body: btoa(JSON.stringify({ version: 5, cursor: 0, eventEpoch: 'remote-epoch', heartbeatMs: 1_000 })),
        });
      }
      if (envelope.path.includes('/client/playback-audio')) {
        playbackPoll += 1;
        if (playbackPoll > 2) throw new Error('Playback relay did not preserve the sealed state header.');
        return jsonResponse(
          playbackPoll === 1
            ? {
                status: 200,
                headers: [['content-type', 'application/vnd.doompi.pcm-s16le']],
                body: btoa('\u0001\u0002'),
              }
            : { status: 204, headers: [['x-doompi-playback-state', 'sealed']], body: '' },
        );
      }
      if (envelope.path.includes('/realtime/negotiate')) {
        return jsonResponse({
          status: 200,
          headers: [['content-type', 'application/json']],
          body: btoa(JSON.stringify({ sdp: 'remote-answer' })),
        });
      }
      return jsonResponse({ status: 204, headers: [], body: '' });
    });

    const transport = new BrowserVoiceMediaTransport('peer/work-host/voice-session');
    await transport.connect('client', 'connection', capabilities);
    await transport.sendAudio('client', 'connection', 'capture', new Uint8Array([3, 4]));
    await expect(
      transport.receivePlaybackAudio('client', 'connection', 'playback', new AbortController().signal),
    ).resolves.toEqual(new Uint8Array([1, 2]));
    await expect(
      transport.realtimeNegotiate('client', 'connection', 'activation', 'offer', new AbortController().signal),
    ).resolves.toBe('remote-answer');
    await transport.disconnect('client', 'connection');

    expect(relayed.map(({ path }) => path)).toEqual([
      '/client/connect',
      '/client/audio?clientId=client&connectionId=connection&captureId=capture',
      '/client/playback-audio?clientId=client&connectionId=connection&playbackId=playback',
      '/client/playback-audio?clientId=client&connectionId=connection&playbackId=playback',
      '/client/realtime/negotiate',
      '/client/disconnect',
    ]);
    expect(relayed.every(({ path }) => !path.startsWith('/host/') && !path.startsWith('/hub/'))).toBe(true);
  });
});
