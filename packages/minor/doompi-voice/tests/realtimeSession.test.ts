import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeSession, type RealtimeSessionIdentity } from '../src/services/realtimeSession';
import type { IClock } from '../src/types';
import type { RealtimeActionRequest, RealtimeProvider } from '../src/types/realtime';

const identity: RealtimeSessionIdentity = {
  sessionId: 'session',
  activationId: 'activation',
  mediaLeaseId: 'lease',
  connectionId: 'connection',
};
const request: RealtimeActionRequest = { activationId: 'activation', requestId: 'request', text: 'Run tests' };
const clock: IClock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clear: (timer) => clearTimeout(timer),
};
function fixture() {
  const ownsMedia = vi.fn(() => true);
  const stopMedia = vi.fn();
  const createCall = vi.fn<RealtimeProvider['createCall']>(async () => ({ sdp: 'answer', callId: 'rtc_test' }));
  const session = new RealtimeSession({ identity, provider: { createCall }, clock, ownsMedia, stopMedia });
  return { session, ownsMedia, stopMedia, createCall };
}
async function activate(session: RealtimeSession) {
  await session.negotiate(identity, { sdp: 'offer', instructions: '' });
  session.mediaConnected(identity);
  session.receive(identity, JSON.stringify({ type: 'session.started', session: { id: 'test' } }));
}

afterEach(() => vi.useRealTimers());

describe('one-activation realtime lifecycle', () => {
  it('requires provider readiness and media connectivity, not merely an SDP response', async () => {
    const { session } = fixture();
    await session.negotiate(identity, { sdp: 'offer', instructions: '' });
    expect(session.state).toBe('connecting');
    session.mediaConnected(identity);
    expect(session.state).toBe('connecting');
    session.receive(identity, JSON.stringify({ type: 'session.started', session: { id: 'test' } }));
    expect(session.state).toBe('active');
    session.close();
  });

  it.each(['sessionId', 'activationId', 'mediaLeaseId', 'connectionId'] as const)(
    'rejects stale %s identities without closing the current session',
    async (key) => {
      const { session, createCall } = fixture();
      await expect(
        session.negotiate({ ...identity, [key]: 'stale' }, { sdp: 'offer', instructions: '' }),
      ).rejects.toThrow();
      expect(createCall).not.toHaveBeenCalled();
      await activate(session);
      expect(session.receive({ ...identity, [key]: 'stale' }, '{"type":"error"}')).toBeUndefined();
      expect(session.state).toBe('active');
      session.close();
    },
  );

  it('does not dispatch a delegation or malformed content to any coding agent', async () => {
    const { session } = fixture();
    await activate(session);
    expect(
      session.receive(
        identity,
        JSON.stringify({
          type: 'delegation.created',
          item: {
            type: 'delegation',
            target: 'client',
            id: 'request',
            content: [null, { type: 'input_text', text: 'Run tests' }],
          },
        }),
      ),
    ).toEqual({ type: 'request', requestId: 'request', text: 'Run tests' });
    expect(session.state).toBe('active');
    session.close();
  });

  it('fails on provider errors and stops media before notifying cancellation listeners', async () => {
    const { session, createCall, stopMedia } = fixture();
    const order: string[] = [];
    createCall.mockImplementationOnce(async (_request, signal) => {
      signal.addEventListener('abort', () => order.push('abort'));
      return { sdp: 'answer', callId: 'rtc_test' };
    });
    stopMedia.mockImplementation(() => order.push('stop'));
    await activate(session);
    session.receive(identity, '{"type":"error","error":{"message":"private data"}}');
    expect(session.state).toBe('failed');
    expect(order).toEqual(['stop', 'abort']);
    session.close();
    expect(stopMedia).toHaveBeenCalledOnce();
  });

  it('ends on ownership loss without waiting for another provider event', async () => {
    const { session, ownsMedia, stopMedia } = fixture();
    await activate(session);
    ownsMedia.mockReturnValue(false);
    expect(session.checkOwnership()).toBe(false);
    expect(session.state).toBe('closed');
    expect(stopMedia).toHaveBeenCalledOnce();
  });

  it('bounds a provider that ignores cancellation and never resolves', async () => {
    vi.useFakeTimers();
    const { session, createCall, stopMedia } = fixture();
    createCall.mockImplementation(() => new Promise(() => {}));
    const result = session.negotiate(identity, { sdp: 'offer', instructions: '' });
    const rejected = expect(result).rejects.toThrow('Realtime negotiation failed.');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(session.state).toBe('failed');
    expect(stopMedia).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects late negotiation and requires a fresh instance for reconnect', async () => {
    const { session, createCall } = fixture();
    let resolve!: (call: { sdp: string; callId: string }) => void;
    createCall.mockImplementation(
      () =>
        new Promise((accept) => {
          resolve = accept;
        }),
    );
    const result = session.negotiate(identity, { sdp: 'offer', instructions: '' });
    const rejected = expect(result).rejects.toThrow();
    await Promise.resolve();
    session.close();
    await rejected;
    resolve({ sdp: 'late', callId: 'rtc_late' });
    await expect(session.negotiate(identity, { sdp: 'again', instructions: '' })).rejects.toThrow();
    expect(session.state).toBe('closed');
  });
  it('bounds the provider/media readiness handshake after call creation', async () => {
    vi.useFakeTimers();
    const { session, stopMedia } = fixture();
    await session.negotiate(identity, { sdp: 'offer', instructions: '' });
    session.mediaConnected(identity);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(session.state).toBe('failed');
    expect(stopMedia).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles teardown reentrancy without repeating media cleanup', async () => {
    const { session, stopMedia } = fixture();
    await activate(session);
    stopMedia.mockImplementation(() => session.close());
    session.close();
    expect(stopMedia).toHaveBeenCalledOnce();
    expect(session.state).toBe('closed');
  });
});

describe('bounded explicit delivery', () => {
  it('coalesces duplicate IDs, rejects changed payloads, and distinguishes submitted from completed', async () => {
    const { session } = fixture();
    await activate(session);
    const deliver = vi.fn();
    const first = session.submit(identity, request, deliver);
    expect(session.submit(identity, request, deliver)).toBe(first);
    await expect(session.submit(identity, { ...request, text: 'Different' }, deliver)).resolves.toBe('rejected');
    await expect(first).resolves.toBe('submitted');
    await expect(session.submit(identity, request, deliver)).resolves.toBe('submitted');
    expect(deliver).toHaveBeenCalledOnce();
    session.close();
  });

  it('reports busy rather than overwriting an outstanding request', async () => {
    const { session } = fixture();
    await activate(session);
    const deliver = vi.fn(() => new Promise<void>(() => {}));
    const first = session.submit(identity, request, deliver);
    await Promise.resolve();
    await expect(session.submit(identity, { ...request, requestId: 'second' }, deliver)).resolves.toBe('busy');
    session.close();
    await expect(first).resolves.toBe('uncertain');
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('retains uncertain results and does not replay or dispatch alongside a timed-out operation', async () => {
    vi.useFakeTimers();
    const { session } = fixture();
    await activate(session);
    const deliver = vi.fn(() => new Promise<void>(() => {}));
    const first = session.submit(identity, request, deliver);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(first).resolves.toBe('uncertain');
    await expect(session.submit(identity, request, deliver)).resolves.toBe('uncertain');
    await expect(session.submit(identity, { ...request, requestId: 'second' }, deliver)).resolves.toBe('busy');
    expect(deliver).toHaveBeenCalledOnce();
    session.close();
  });

  it('does not deliver after close between admission and callback invocation', async () => {
    const { session } = fixture();
    await activate(session);
    const deliver = vi.fn();
    const result = session.submit(identity, request, deliver);
    await Promise.resolve();
    session.close();
    await result;
    expect(deliver).not.toHaveBeenCalled();
  });
  it('does not evict retained IDs and accidentally replay an old submission', async () => {
    const { session } = fixture();
    await activate(session);
    const deliver = vi.fn();
    for (let index = 0; index < 128; index += 1) {
      await expect(session.submit(identity, { ...request, requestId: String(index) }, deliver)).resolves.toBe(
        'submitted',
      );
    }
    await expect(session.submit(identity, { ...request, requestId: 'overflow' }, deliver)).resolves.toBe('rejected');
    await expect(session.submit(identity, { ...request, requestId: '0' }, deliver)).resolves.toBe('submitted');
    expect(deliver).toHaveBeenCalledTimes(128);
    session.close();
  });
});
