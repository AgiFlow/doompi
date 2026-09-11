import { describe, expect, it, vi } from 'vitest';
import type { DoomChildSessionRequest, DoomChildSessionRuntime } from '../../src/schemas/childSession.ts';
import { createDoomChildSessionService } from '../../src/services/childSession.ts';

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function request(runId = 'run-1'): DoomChildSessionRequest {
  return {
    runId,
    parentSessionId: 'parent-1',
    scope: { rootSessionId: 'parent-1', scopeKey: runId },
    source: { kind: 'fresh' },
    agent: 'worker',
    task: 'Do the work.',
    cwd: '/repo',
    environment: {},
  };
}

function runtime(overrides: Partial<DoomChildSessionRuntime> = {}): DoomChildSessionRuntime {
  return {
    sessionId: 'child-1',
    prompt: vi.fn(() => new Promise<void>(() => undefined)),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    ...overrides,
  };
}

function service(
  factory: (request: DoomChildSessionRequest, signal?: AbortSignal) => Promise<DoomChildSessionRuntime>,
) {
  let timestamp = 100;
  return createDoomChildSessionService(factory, { now: () => timestamp++ });
}

describe('createDoomChildSessionService', () => {
  it('publishes completion only after cleanup and replays it without retaining late subscribers', async () => {
    const prompt = deferred();
    const dispose = deferred();
    const child = runtime({
      sessionFile: '/sessions/child.jsonl',
      prompt: vi.fn(() => prompt.promise),
      dispose: vi.fn(() => dispose.promise),
    });
    const sessions = service(async () => child);
    const handle = await sessions.start(request());
    const events: Array<{ state: string; timestamp: number; sessionFile?: string }> = [];
    handle.subscribe((event) => events.push(event));

    expect(events).toEqual([
      { runId: 'run-1', state: 'running', timestamp: 100, sessionFile: '/sessions/child.jsonl' },
    ]);
    prompt.resolve();
    await vi.waitFor(() => expect(child.dispose).toHaveBeenCalledOnce());
    expect(handle.state()).toBe('running');
    expect(sessions.get('run-1')).toBe(handle);

    dispose.resolve();
    await vi.waitFor(() => expect(handle.state()).toBe('completed'));
    expect(events.map((event) => event.state)).toEqual(['running', 'completed']);
    expect(events[1]?.timestamp).toBe(101);
    expect(sessions.get('run-1')).toBeUndefined();

    const lateEvents: string[] = [];
    const unsubscribe = handle.subscribe((event) => lateEvents.push(event.state));
    expect(unsubscribe()).toBe(false);
    expect(lateEvents).toEqual(['completed']);
    await handle.dispose();
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it('publishes prompt failure and disposes the runtime', async () => {
    const prompt = deferred();
    const child = runtime({ prompt: vi.fn(() => prompt.promise) });
    const sessions = service(async () => child);
    const handle = await sessions.start(request());
    const events: Array<{ state: string; message?: string }> = [];
    handle.subscribe((event) => events.push(event));

    prompt.reject(new Error('model failed'));

    await vi.waitFor(() => expect(handle.state()).toBe('failed'));
    expect(events.map((event) => event.state)).toEqual(['running', 'failed']);
    expect(events[1]?.message).toBe('model failed');
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it('stops once and does not replace stopped state when the prompt later settles', async () => {
    const prompt = deferred();
    const child = runtime({ prompt: vi.fn(() => prompt.promise) });
    const sessions = service(async () => child);
    const handle = await sessions.start(request());
    const events: string[] = [];
    handle.subscribe((event) => events.push(event.state));

    const first = handle.stop('cancelled');
    const second = handle.stop('ignored');
    await Promise.all([first, second]);
    prompt.resolve();
    await Promise.resolve();

    expect(events).toEqual(['running', 'stopped']);
    expect(handle.state()).toBe('stopped');
    expect(child.abort).toHaveBeenCalledOnce();
    expect(child.dispose).toHaveBeenCalledOnce();
  });

  it('rejects duplicate run ids while the first runtime is starting', async () => {
    const created = deferred<DoomChildSessionRuntime>();
    const sessions = service(async () => created.promise);
    const first = sessions.start(request());

    await expect(sessions.start(request())).rejects.toThrow("Child run 'run-1' already exists.");
    const child = runtime();
    created.resolve(child);
    const handle = await first;
    await handle.dispose();
  });

  it('disposes a runtime when startup is aborted during factory creation', async () => {
    const created = deferred<DoomChildSessionRuntime>();
    const child = runtime();
    const sessions = service(async () => created.promise);
    const controller = new AbortController();
    const pending = sessions.start(request(), controller.signal);

    controller.abort(new Error('cancel startup'));
    created.resolve(child);

    await expect(pending).rejects.toThrow('cancel startup');
    expect(child.prompt).not.toHaveBeenCalled();
    expect(child.dispose).toHaveBeenCalledOnce();
    expect(sessions.get('run-1')).toBeUndefined();
  });

  it('closes runtimes that finish starting during shutdown and rejects future starts', async () => {
    const created = deferred<DoomChildSessionRuntime>();
    const child = runtime();
    const sessions = service(async () => created.promise);
    const pending = sessions.start(request());
    const closing = sessions.close();
    created.resolve(child);

    await expect(pending).rejects.toThrow('Child session startup was cancelled.');
    await closing;
    expect(child.dispose).toHaveBeenCalledOnce();
    await expect(sessions.start(request('run-2'))).rejects.toThrow('The Doom child-session service is closed.');
    await expect(sessions.close()).resolves.toBeUndefined();
  });

  it('publishes cleanup failure and reports it during service shutdown', async () => {
    const cleanupError = new Error('lease release failed');
    const child = runtime({
      prompt: vi.fn(async () => undefined),
      dispose: vi.fn(async () => {
        throw cleanupError;
      }),
    });
    const sessions = service(async () => child);
    const handle = await sessions.start(request());
    const events: Array<{ state: string; message?: string }> = [];
    handle.subscribe((event) => events.push(event));

    await vi.waitFor(() => expect(handle.state()).toBe('failed'));
    expect(events.at(-1)).toMatchObject({
      state: 'failed',
      message: 'Child session cleanup failed: lease release failed',
    });
    await expect(handle.dispose()).rejects.toBe(cleanupError);
    await expect(sessions.close()).rejects.toMatchObject({
      name: 'AggregateError',
      message: 'Doom child-session shutdown failed.',
    });
  });
});
