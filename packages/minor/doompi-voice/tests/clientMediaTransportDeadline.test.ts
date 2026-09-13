import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserVoiceMediaTransport } from '../src/web/stores/clientMediaTransport';
import { voiceMediaWakes } from '../src/web/stores/voiceMediaWakeStore';

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
  realtime: true,
} as const;

function jsonResponse(value: object): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
}

function pendingResponse(): Promise<Response> {
  return new Promise(() => undefined);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  voiceMediaWakes.reset();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('browser voice media control request deadlines', () => {
  it('bounds a stalled event fetch and forwards its parent signal', async () => {
    vi.mocked(sealedTransport.fetch).mockImplementation(() => pendingResponse());
    const transport = new BrowserVoiceMediaTransport('event-deadline');
    const controller = new AbortController();

    const event = transport.nextEvent('client', 'connection', 0, controller.signal);
    const rejected = expect(event).rejects.toThrow('Voice media control request timed out.');
    expect(vi.mocked(sealedTransport.fetch).mock.calls[0]?.[1]?.signal).toBe(controller.signal);

    await vi.advanceTimersByTimeAsync(8_000);
    await rejected;
  });

  it('bounds a stalled push heartbeat', async () => {
    vi.mocked(sealedTransport.fetch)
      .mockResolvedValueOnce(jsonResponse({ version: 6, cursor: 0, eventEpoch: 'epoch', heartbeatMs: 1 }))
      .mockImplementationOnce(() => pendingResponse());
    const transport = new BrowserVoiceMediaTransport('heartbeat-deadline');
    await transport.connect('client', 'connection', capabilities);

    const event = transport.nextEvent('client', 'connection', 0, new AbortController().signal);
    const rejected = expect(event).rejects.toThrow('Voice media control request timed out.');
    await vi.advanceTimersByTimeAsync(1);
    expect(String(vi.mocked(sealedTransport.fetch).mock.calls[1]?.[0])).toContain('/client/heartbeat');

    await vi.advanceTimersByTimeAsync(8_000);
    await rejected;
  });

  it('bounds a stalled realtime control post and aborts its transport signal', async () => {
    vi.mocked(sealedTransport.fetch).mockImplementation(() => pendingResponse());
    const transport = new BrowserVoiceMediaTransport('post-deadline');

    const post = transport.realtimeEvent('client', 'connection', 'activation', '{"type":"ready"}');
    const rejected = expect(post).rejects.toThrow('Voice media control request timed out.');
    const signal = vi.mocked(sealedTransport.fetch).mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(8_000);
    await rejected;
    expect(signal?.aborted).toBe(true);
  });

  it('rejects promptly on parent abort even when the transport ignores it', async () => {
    vi.mocked(sealedTransport.fetch).mockImplementation(() => pendingResponse());
    const transport = new BrowserVoiceMediaTransport('parent-abort');
    const controller = new AbortController();
    const reason = new Error('caller stopped');

    const event = transport.nextEvent('client', 'connection', 0, controller.signal);
    const rejected = expect(event).rejects.toBe(reason);
    controller.abort(reason);

    await rejected;
    expect(vi.mocked(sealedTransport.fetch).mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it('bounds response body consumption and cancels the stalled body', async () => {
    const cancel = vi.fn(async () => undefined);
    const response = {
      ok: true,
      status: 200,
      body: { cancel },
      json: () => new Promise<unknown>(() => undefined),
    } as unknown as Response;
    vi.mocked(sealedTransport.fetch).mockResolvedValue(response);
    const transport = new BrowserVoiceMediaTransport('body-deadline');

    const event = transport.nextEvent('client', 'connection', 0, new AbortController().signal);
    const rejected = expect(event).rejects.toThrow('Voice media control request timed out.');
    await vi.advanceTimersByTimeAsync(8_000);

    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels a response body that arrives after the request deadline', async () => {
    let resolveResponse!: (response: Response) => void;
    vi.mocked(sealedTransport.fetch).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const transport = new BrowserVoiceMediaTransport('late-body');
    const event = transport.nextEvent('client', 'connection', 0, new AbortController().signal);
    const rejected = expect(event).rejects.toThrow('Voice media control request timed out.');
    await vi.advanceTimersByTimeAsync(8_000);
    await rejected;

    const cancel = vi.fn(async () => undefined);
    resolveResponse({ body: { cancel } } as unknown as Response);
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds negotiation without replacing its caller signal', async () => {
    vi.mocked(sealedTransport.fetch).mockImplementation(() => pendingResponse());
    const transport = new BrowserVoiceMediaTransport('negotiation-deadline');
    const controller = new AbortController();

    const negotiation = transport.realtimeNegotiate('client', 'connection', 'activation', 'offer', controller.signal);
    const rejected = expect(negotiation).rejects.toThrow('Voice media control request timed out.');
    expect(vi.mocked(sealedTransport.fetch).mock.calls[0]?.[1]?.signal).toBe(controller.signal);

    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
  });
});
