import { describe, expect, it, vi } from 'vitest';

import { createCodexRealtimeProvider } from '../src/services/codexRealtime';
import type { RealtimeAuth } from '../src/types/realtime';

const offer = 'v=0\r\na=offer\r\n';
const answer = 'v=0\r\na=answer\r\n';

function auth(): RealtimeAuth {
  return {
    credentials: vi.fn(async () => ({ accessToken: 'initial-token', accountId: 'account-1' })),
    refresh: vi.fn(async () => ({ accessToken: 'refreshed-token', accountId: 'account-1' })),
  };
}

function response(status = 200, body = answer, location = '/backend-api/codex/realtime/calls/rtc_call-1'): Response {
  return new Response(body, { status, headers: location ? { location } : {} });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function trackedResponse(status: number, canceled: (reason?: unknown) => unknown): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      cancel(reason) {
        canceled(reason);
      },
    }),
    { status },
  );
}

describe('Codex V3 realtime call provider', () => {
  it('creates the source-backed JSON call with truthful identity and extracts SDP and Location', async () => {
    let capturedUrl: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    const fetch: typeof globalThis.fetch = vi.fn(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return response();
    });
    const provider = createCodexRealtimeProvider({ auth: auth(), fetch });

    await expect(
      provider.createCall({ sdp: offer, instructions: 'Help the user.' }, new AbortController().signal),
    ).resolves.toEqual({ sdp: answer, callId: 'rtc_call-1' });

    expect(fetch).toHaveBeenCalledOnce();
    expect(capturedUrl).toBe(
      'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas',
    );
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.redirect).toBe('error');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer initial-token');
    expect(headers.get('chatgpt-account-id')).toBe('account-1');
    expect(headers.get('openai-alpha')).toBe('quicksilver=v2');
    expect(headers.get('originator')).toBe('doompi_voice');
    expect(headers.get('user-agent')).toBe('@agimon-ai/doompi-voice');
    expect(typeof capturedInit?.body).toBe('string');
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      sdp: offer,
      session: {
        instructions: 'Help the user.',
        audio: { output: { voice: 'cove' } },
        delegation: { type: 'client' },
        model: 'gpt-live-1-codex',
      },
    });
  });

  it('refreshes once after an explicit 401, cancels the retry body and uses only subscription credentials', async () => {
    const realtimeAuth = auth();
    const canceled = vi.fn();
    const fetch = vi.fn().mockResolvedValueOnce(trackedResponse(401, canceled)).mockResolvedValueOnce(response());
    const provider = createCodexRealtimeProvider({ auth: realtimeAuth, fetch });

    await expect(provider.createCall({ sdp: offer, instructions: '' }, new AbortController().signal)).resolves.toEqual({
      sdp: answer,
      callId: 'rtc_call-1',
    });
    expect(canceled).toHaveBeenCalledOnce();
    expect(realtimeAuth.refresh).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('authorization')).toBe('Bearer refreshed-token');
  });

  it('does not retry ambiguous transport failures or malformed successful responses', async () => {
    const failedFetch = vi.fn(async () => {
      throw new Error(`network failure ${offer} initial-token`);
    });
    const failedProvider = createCodexRealtimeProvider({ auth: auth(), fetch: failedFetch });
    await expect(
      failedProvider.createCall({ sdp: offer, instructions: '' }, new AbortController().signal),
    ).rejects.toThrow('Realtime call request failed.');
    expect(failedFetch).toHaveBeenCalledOnce();

    const malformedFetch = vi.fn(async () => response(200, answer, ''));
    const malformedProvider = createCodexRealtimeProvider({ auth: auth(), fetch: malformedFetch });
    await expect(
      malformedProvider.createCall({ sdp: offer, instructions: '' }, new AbortController().signal),
    ).rejects.toThrow('missing its call ID');
    expect(malformedFetch).toHaveBeenCalledOnce();
  });

  it('rejects redirects, oversized requests and oversized response bodies', async () => {
    const redirectProvider = createCodexRealtimeProvider({ auth: auth(), fetch: vi.fn(async () => response(302)) });
    await expect(
      redirectProvider.createCall({ sdp: offer, instructions: '' }, new AbortController().signal),
    ).rejects.toThrow('redirect was rejected');

    const unusedFetch = vi.fn(async () => response());
    const boundedProvider = createCodexRealtimeProvider({ auth: auth(), fetch: unusedFetch });
    await expect(
      boundedProvider.createCall({ sdp: 'x'.repeat(65_537), instructions: '' }, new AbortController().signal),
    ).rejects.toThrow('configured limit');
    expect(unusedFetch).not.toHaveBeenCalled();

    const largeProvider = createCodexRealtimeProvider({
      auth: auth(),
      fetch: vi.fn(async () => response(200, 'x'.repeat(65_537))),
    });
    await expect(
      largeProvider.createCall({ sdp: offer, instructions: '' }, new AbortController().signal),
    ).rejects.toThrow('response exceeds');
  });

  it('accepts UUID call IDs and rejects unsupported deadlines before auth access', async () => {
    const uuid = '019eb97d-8e9a-7ff3-94b0-ea019babd5d7';
    const realtimeAuth = auth();
    const provider = createCodexRealtimeProvider({
      auth: realtimeAuth,
      fetch: vi.fn(async () => response(200, answer, `/realtime/calls/${uuid}?ignored=true`)),
    });
    await expect(provider.createCall({ sdp: offer, instructions: '' }, new AbortController().signal)).resolves.toEqual({
      sdp: answer,
      callId: uuid,
    });

    const invalid = createCodexRealtimeProvider({ auth: realtimeAuth, fetch: vi.fn(), deadlineMs: 30_001 });
    await expect(invalid.createCall({ sdp: offer, instructions: '' }, new AbortController().signal)).rejects.toThrow(
      'deadline',
    );
  });

  it('bounds instructions, validates credentials and sanitizes auth failures', async () => {
    const unusedFetch = vi.fn(async () => response());
    const provider = createCodexRealtimeProvider({ auth: auth(), fetch: unusedFetch });
    await expect(provider.createCall({ sdp: '', instructions: '' }, new AbortController().signal)).rejects.toThrow(
      'SDP',
    );
    await expect(
      provider.createCall({ sdp: offer, instructions: 'x'.repeat(16_385) }, new AbortController().signal),
    ).rejects.toThrow('instructions');

    const invalidAuth: RealtimeAuth = {
      credentials: async () => ({ accessToken: ' bad', accountId: 'account-1' }),
      refresh: async () => ({ accessToken: 'unused', accountId: 'unused' }),
    };
    await expect(
      createCodexRealtimeProvider({ auth: invalidAuth, fetch: unusedFetch }).createCall(
        { sdp: offer, instructions: '' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('request failed');

    const secretAuth: RealtimeAuth = {
      credentials: async () => {
        throw new Error('secret credential detail');
      },
      refresh: async () => ({ accessToken: 'unused', accountId: 'unused' }),
    };
    await expect(
      createCodexRealtimeProvider({ auth: secretAuth, fetch: unusedFetch }).createCall(
        { sdp: offer, instructions: '' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('authorization is unavailable');
    expect(unusedFetch).not.toHaveBeenCalled();
  });

  it('sanitizes aborts and response stream failures', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const realtimeAuth = auth();
    const abortProvider = createCodexRealtimeProvider({
      auth: realtimeAuth,
      fetch: vi.fn(async () => {
        throw new Error('secret transport detail');
      }),
    });
    await expect(abortProvider.createCall({ sdp: offer, instructions: '' }, aborted.signal)).rejects.toThrow('aborted');
    expect(realtimeAuth.credentials).not.toHaveBeenCalled();

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('secret stream detail'));
      },
    });
    const streamProvider = createCodexRealtimeProvider({
      auth: auth(),
      fetch: vi.fn(
        async () => new Response(stream, { headers: { location: '/backend-api/codex/realtime/calls/rtc_stream' } }),
      ),
    });
    await expect(
      streamProvider.createCall({ sdp: offer, instructions: '' }, new AbortController().signal),
    ).rejects.toThrow('could not be read');
  });

  it('settles bounded deadlines for non-cooperative credentials, refresh, fetch and response reads', async () => {
    const hangingCredentials: RealtimeAuth = {
      credentials: vi.fn(() => new Promise<never>(() => undefined)),
      refresh: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const credentialsFetch = vi.fn();
    await expect(
      createCodexRealtimeProvider({ auth: hangingCredentials, fetch: credentialsFetch, deadlineMs: 10 }).createCall(
        { sdp: offer, instructions: '' },
        new AbortController().signal,
      ),
    ).rejects.toThrow('aborted');
    expect(credentialsFetch).not.toHaveBeenCalled();

    const hangingRefresh: RealtimeAuth = {
      credentials: vi.fn(async () => ({ accessToken: 'initial-token', accountId: 'account-1' })),
      refresh: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const refreshCanceled = vi.fn();
    await expect(
      createCodexRealtimeProvider({
        auth: hangingRefresh,
        fetch: vi.fn(async () => trackedResponse(401, refreshCanceled)),
        deadlineMs: 10,
      }).createCall({ sdp: offer, instructions: '' }, new AbortController().signal),
    ).rejects.toThrow('aborted');
    expect(refreshCanceled).toHaveBeenCalledOnce();

    await expect(
      createCodexRealtimeProvider({
        auth: auth(),
        fetch: vi.fn(() => new Promise<never>(() => undefined)),
        deadlineMs: 10,
      }).createCall({ sdp: offer, instructions: '' }, new AbortController().signal),
    ).rejects.toThrow('aborted');

    const readCanceled = vi.fn();
    await expect(
      createCodexRealtimeProvider({
        auth: auth(),
        fetch: vi.fn(
          async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                cancel(reason) {
                  readCanceled(reason);
                },
              }),
              { headers: { location: '/realtime/calls/rtc_hanging' } },
            ),
        ),
        deadlineMs: 10,
      }).createCall({ sdp: offer, instructions: '' }, new AbortController().signal),
    ).rejects.toThrow('aborted');
    expect(readCanceled).toHaveBeenCalledOnce();
  });

  it('does not continue after cancellation and cancels a late fetch response', async () => {
    const credentials = deferred<{ accessToken: string; accountId: string }>();
    const fetch = vi.fn();
    const controller = new AbortController();
    const provider = createCodexRealtimeProvider({
      auth: { credentials: vi.fn(() => credentials.promise), refresh: vi.fn(() => credentials.promise) },
      fetch,
    });
    const call = provider.createCall({ sdp: offer, instructions: '' }, controller.signal);
    controller.abort();
    await expect(call).rejects.toThrow('aborted');
    credentials.resolve({ accessToken: 'late-token', accountId: 'late-account' });
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();

    const lateResponse = deferred<Response>();
    const lateCanceled = vi.fn();
    const fetchController = new AbortController();
    const lateFetch = vi.fn(() => lateResponse.promise);
    const lateProvider = createCodexRealtimeProvider({ auth: auth(), fetch: lateFetch });
    const lateCall = lateProvider.createCall({ sdp: offer, instructions: '' }, fetchController.signal);
    await vi.waitFor(() => expect(lateFetch).toHaveBeenCalledOnce());
    fetchController.abort();
    await expect(lateCall).rejects.toThrow('aborted');
    lateResponse.resolve(trackedResponse(200, lateCanceled));
    await vi.waitFor(() => expect(lateCanceled).toHaveBeenCalledOnce());
  });

  it('rejects invalid successful responses, untrusted endpoints and HTTP failures', async () => {
    const cases = [
      new Response(null, { headers: { location: '/realtime/calls/rtc_empty' } }),
      new Response(new Uint8Array([0xff]), { headers: { location: '/realtime/calls/rtc_utf8' } }),
      response(200, answer, '/realtime/calls/not-an-id'),
      new Response(answer, {
        headers: { 'content-length': '-1', location: '/realtime/calls/rtc_length' },
      }),
    ];
    for (const invalidResponse of cases) {
      const provider = createCodexRealtimeProvider({ auth: auth(), fetch: vi.fn(async () => invalidResponse) });
      await expect(
        provider.createCall({ sdp: offer, instructions: '' }, new AbortController().signal),
      ).rejects.toThrow();
    }

    const endpointAuth = auth();
    expect(() =>
      createCodexRealtimeProvider({
        auth: endpointAuth,
        fetch: vi.fn(),
        endpoint: 'https://example.com/call',
      } as Parameters<typeof createCodexRealtimeProvider>[0]),
    ).toThrow('cannot be overridden');
    expect(endpointAuth.credentials).not.toHaveBeenCalled();

    const failedCanceled = vi.fn();
    const failed = createCodexRealtimeProvider({
      auth: auth(),
      fetch: vi.fn(async () => trackedResponse(500, failedCanceled)),
    });
    await expect(failed.createCall({ sdp: offer, instructions: '' }, new AbortController().signal)).rejects.toThrow(
      'HTTP 500',
    );
    expect(failedCanceled).toHaveBeenCalledOnce();
  });
});
