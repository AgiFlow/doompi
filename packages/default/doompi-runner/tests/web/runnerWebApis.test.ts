import { sealedTransport } from '@agimon-ai/doompi-web-security/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNNER_LOG_STREAM_EVENT, RUNNER_SCREEN_EVENT } from '../../src/types/webRunnerLog.ts';
import { fetchRunnerLog, followRunnerLog } from '../../src/web/api/logApi.ts';
import { decodeChunk, sendRunnerInput, watchRunnerScreen } from '../../src/web/api/screenApi.ts';

vi.mock('@agimon-ai/doompi-web-security/browser', () => ({ sealedTransport: { fetch: vi.fn() } }));

const fetch = vi.mocked(sealedTransport.fetch);

type Listener = (event: { data?: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Listener>();
  readonly close = vi.fn();

  constructor(readonly url: string | URL) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener as unknown as Listener);
  }

  emit(type: string, data?: string): void {
    this.listeners.get(type)?.({ data });
  }
}

beforeEach(() => {
  fetch.mockReset();
  FakeEventSource.instances.length = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('runner log HTTP API', () => {
  it('returns a valid log slice and forwards the abort signal', async () => {
    const controller = new AbortController();
    const slice = { text: 'done', exists: true, running: false };
    fetch.mockResolvedValue(Response.json(slice));

    await expect(fetchRunnerLog('session/a', 'run one', { grep: 'done' }, controller.signal)).resolves.toEqual({
      slice,
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/session%2Fa/plugin/runner/runners/run%20one/log?session=session%2Fa&grep=done',
      {
        signal: controller.signal,
      },
    );
  });

  it('uses a structured hub error when one is returned', async () => {
    fetch.mockResolvedValue(Response.json({ error: 'not found' }, { status: 404 }));

    await expect(fetchRunnerLog('s', 'r')).resolves.toEqual({ error: 'not found' });
  });

  it('falls back to the response status for invalid and unreadable bodies', async () => {
    fetch.mockResolvedValueOnce(Response.json({ text: 42 }));
    await expect(fetchRunnerLog('s', 'r')).resolves.toEqual({ error: 'The hub answered 200.' });

    fetch.mockResolvedValueOnce(Response.json({ error: 42 }, { status: 503 }));
    await expect(fetchRunnerLog('s', 'r')).resolves.toEqual({ error: 'The hub answered 503.' });

    fetch.mockResolvedValueOnce(new Response('not json', { status: 502 }));
    await expect(fetchRunnerLog('s', 'r')).resolves.toEqual({ error: 'The hub answered 502.' });
  });

  it('distinguishes replaced requests from an unreachable hub', async () => {
    fetch.mockRejectedValueOnce(new DOMException('replaced', 'AbortError'));
    await expect(fetchRunnerLog('s', 'r')).resolves.toEqual({ error: '' });

    fetch.mockRejectedValueOnce(new Error('offline'));
    await expect(fetchRunnerLog('s', 'r')).resolves.toEqual({ error: 'The cockpit hub is unreachable.' });
  });
});

describe('runner log stream', () => {
  it('ignores malformed frames, resumes from delivered offsets, and stands down after the end event', () => {
    const onEvent = vi.fn();
    const onLost = vi.fn();
    followRunnerLog('s', 'r', 4, { onEvent, onLost });
    const source = FakeEventSource.instances[0]!;

    source.emit(RUNNER_LOG_STREAM_EVENT, '{');
    source.emit(RUNNER_LOG_STREAM_EVENT, JSON.stringify(null));
    source.emit(RUNNER_LOG_STREAM_EVENT, JSON.stringify({ lines: 'wrong' }));
    source.emit(RUNNER_LOG_STREAM_EVENT, JSON.stringify({ lines: ['done'], offset: 9, ended: true }));
    source.emit('error');

    expect(onEvent).toHaveBeenCalledWith({ lines: ['done'], offset: 9, ended: true });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onLost).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledTimes(2);
  });

  it('retries from the newest offset and reports a stream that stays down', async () => {
    vi.useFakeTimers();
    const onLost = vi.fn();
    followRunnerLog('s', 'r', 2, { onEvent: vi.fn(), onLost });

    FakeEventSource.instances[0]!.emit(RUNNER_LOG_STREAM_EVENT, JSON.stringify({ lines: ['x'], offset: 7 }));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      FakeEventSource.instances.at(-1)!.emit('error');
      await vi.runOnlyPendingTimersAsync();
    }

    expect(String(FakeEventSource.instances[1]!.url)).toContain('from=7');
    expect(onLost).toHaveBeenCalledOnce();
  });

  it('keeps the starting offset when an event omits one and cancels a scheduled reconnect', () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    const follow = followRunnerLog('s', 'r', 6, { onEvent, onLost: vi.fn() });
    const source = FakeEventSource.instances[0]!;
    source.emit(RUNNER_LOG_STREAM_EVENT, JSON.stringify({ lines: ['still running'] }));
    source.emit('error');

    follow.close();
    vi.runAllTimers();

    expect(onEvent).toHaveBeenCalledWith({ lines: ['still running'] });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(String(source.url)).toContain('from=6');
    expect(source.close).toHaveBeenCalledTimes(2);
  });
});

describe('runner screen API', () => {
  it('decodes base64 terminal bytes and reports accepted, rejected, and failed input', async () => {
    expect([...decodeChunk('AEF6')]).toEqual([0, 65, 122]);
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(sendRunnerInput('session/a', 'run one', 'x')).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      '/api/sessions/session%2Fa/plugin/runner/runners/run%20one/screen/input?session=session%2Fa',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x' }),
      },
    );

    fetch.mockResolvedValueOnce(new Response(null, { status: 409 }));
    await expect(sendRunnerInput('s', 'r', 'x')).resolves.toBe(false);

    fetch.mockRejectedValueOnce(new Error('offline'));
    await expect(sendRunnerInput('s', 'r', 'x')).resolves.toBe(false);
  });

  it('ignores malformed frames and closes after an end event', () => {
    const onEvent = vi.fn();
    const onLost = vi.fn();
    watchRunnerScreen('s', 'r', 3, { onEvent, onLost });
    const source = FakeEventSource.instances[0]!;

    source.emit(RUNNER_SCREEN_EVENT, '{');
    source.emit(RUNNER_SCREEN_EVENT, JSON.stringify([]));
    source.emit(RUNNER_SCREEN_EVENT, JSON.stringify({ chunk: 4 }));
    source.emit(RUNNER_SCREEN_EVENT, JSON.stringify({ chunk: 'QQ==', offset: 8, ended: true }));
    source.emit('error');

    expect(onEvent).toHaveBeenCalledWith({ chunk: 'QQ==', offset: 8, ended: true });
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onLost).not.toHaveBeenCalled();
    expect(source.close).toHaveBeenCalledTimes(2);
  });

  it('retries from the newest offset, reports loss, and supports explicit close', async () => {
    vi.useFakeTimers();
    const onLost = vi.fn();
    const watch = watchRunnerScreen('s', 'r', 1, { onEvent: vi.fn(), onLost });
    FakeEventSource.instances[0]!.emit(RUNNER_SCREEN_EVENT, JSON.stringify({ chunk: 'eA==', offset: 5 }));

    for (let attempt = 0; attempt < 6; attempt += 1) {
      FakeEventSource.instances.at(-1)!.emit('error');
      await vi.runOnlyPendingTimersAsync();
    }

    expect(String(FakeEventSource.instances[1]!.url)).toContain('from=5');
    expect(onLost).toHaveBeenCalledOnce();
    watch.close();
    expect(FakeEventSource.instances.at(-1)!.close).toHaveBeenCalled();
  });
});
