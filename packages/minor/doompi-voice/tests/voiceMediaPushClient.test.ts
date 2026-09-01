import { driveChannel } from '@agimon-ai/doompi-web-contracts/testing';
import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VoiceMediaClientEvent } from '../src/types/clientMedia.ts';
import { BrowserVoiceMediaTransport } from '../src/web/clientMediaTransport.ts';
import { parseVoiceMediaWakePayload, voiceMediaWakeChannel, voiceMediaWakes } from '../src/web/voiceMediaWakeStore.ts';

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
});
