import type {
  DoomChildSessionEvent,
  DoomChildSessionHandle,
  DoomChildSessionRequest,
  DoomChildSessionService,
  DoomChildSessionServiceProvider,
} from '@agimon-ai/doompi-core/child';
import { describe, expect, it } from 'vitest';

import { AsyncJobTracker, type NativeAsyncJobProjection } from '../../src/services/asyncJobTracker';
import { NativeRunCoordinator } from '../../src/services/nativeRunCoordinator';
import type { NativeRunProjectionSink } from '../../src/services/nativeRunProjection';
import type { CompletionNotifierContract } from '../../src/services/notify';
import type { RunResultFile } from '../../src/services/resultWatcher';
import { createSessionScope } from '../../src/services/sessionPaths';

class FakeHandle implements DoomChildSessionHandle {
  readonly runId: string;
  private current: DoomChildSessionEvent;
  private readonly listeners = new Set<(event: DoomChildSessionEvent) => void>();
  readonly steerCalls: string[] = [];
  readonly stopCalls: Array<string | undefined> = [];
  disposeCalls = 0;
  subscribeFailure: Error | undefined;
  disposeFailure: Error | undefined;

  constructor(runId: string, timestamp: number) {
    this.runId = runId;
    this.current = { runId, state: 'running', timestamp };
  }

  state() {
    return this.current.state;
  }

  subscribe(listener: (event: DoomChildSessionEvent) => void): () => void {
    if (this.subscribeFailure) throw this.subscribeFailure;
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  async steer(message: string): Promise<void> {
    this.steerCalls.push(message);
  }

  async stop(reason?: string): Promise<void> {
    this.stopCalls.push(reason);
    this.emit({ runId: this.runId, state: 'stopped', timestamp: 40, message: reason });
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    if (this.disposeFailure) throw this.disposeFailure;
  }

  emit(event: DoomChildSessionEvent): void {
    this.current = event;
    for (const listener of this.listeners) listener(event);
  }
}

class FakeService implements DoomChildSessionService {
  readonly handles = new Map<string, FakeHandle>();
  closeCalls = 0;

  async start(request: DoomChildSessionRequest): Promise<DoomChildSessionHandle> {
    const handle = new FakeHandle(request.runId, 10);
    this.handles.set(request.runId, handle);
    return handle;
  }

  get(runId: string): DoomChildSessionHandle | undefined {
    return this.handles.get(runId);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FakeNotifier implements CompletionNotifierContract {
  readonly results: RunResultFile[] = [];
  attachHost(): void {}
  dispose(): void {}
  async deliver(result: RunResultFile): Promise<boolean> {
    this.results.push(result);
    return true;
  }
}

class FakeProjection implements NativeRunProjectionSink {
  readonly runs = new Map<string, NativeAsyncJobProjection>();

  publish(sessionId: string, projection: NativeAsyncJobProjection): void {
    this.runs.set(`${sessionId}:${projection.runId}`, projection);
  }

  dispose(sessionId: string): void {
    for (const key of this.runs.keys()) if (key.startsWith(`${sessionId}:`)) this.runs.delete(key);
  }
}

function request(runId: string, sessionId: string): DoomChildSessionRequest {
  return {
    runId,
    parentSessionId: sessionId,
    scope: createSessionScope(sessionId),
    source: { kind: 'fresh' },
    agent: 'worker',
    task: `task-${runId}`,
    cwd: '/tmp',
    environment: {},
  };
}

function setup() {
  const service = new FakeService();
  const tracker = new AsyncJobTracker();
  const notifier = new FakeNotifier();
  const projection = new FakeProjection();
  const coordinator = new NativeRunCoordinator(
    { get: () => service } satisfies DoomChildSessionServiceProvider,
    tracker,
    notifier,
    projection,
  );
  return { service, tracker, notifier, projection, coordinator };
}

describe('NativeRunCoordinator', () => {
  it('projects direct events and delivers one completion with the first event timestamp', async () => {
    const { service, tracker, notifier, projection, coordinator } = setup();
    await coordinator.start('session-a', request('run-a', 'session-a'));
    service.handles.get('run-a')!.emit({ runId: 'run-a', state: 'running', timestamp: 10 });
    service.handles.get('run-a')!.emit({ runId: 'run-a', state: 'completed', timestamp: 30, message: 'done' });
    service.handles.get('run-a')!.emit({ runId: 'run-a', state: 'completed', timestamp: 31, message: 'duplicate' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(projection.runs.get('session-a:run-a')).toMatchObject({ status: 'completed', updatedAt: 30 });

    expect(tracker.getNative('session-a', 'run-a')).toMatchObject({
      status: 'completed',
      startedAt: 10,
      updatedAt: 30,
    });
    expect(coordinator.get('session-a', 'run-a')).toBeUndefined();
    expect(notifier.results).toHaveLength(1);
    expect(notifier.results[0]).toMatchObject({ runId: 'run-a', success: true, durationMs: 20 });
  });

  it('routes steer and stop through the typed handle and projects cancellation', async () => {
    const { service, tracker, coordinator } = setup();
    await coordinator.start('session-a', request('run-a', 'session-a'));
    await coordinator.steer('session-a', 'run-a', 'continue');
    await coordinator.stop('session-a', 'run-a', 'cancelled');

    expect(service.handles.get('run-a')?.steerCalls).toEqual(['continue']);
    expect(service.handles.get('run-a')?.stopCalls).toEqual(['cancelled']);
    expect(tracker.getNative('session-a', 'run-a')?.status).toBe('stopped');
  });

  it('isolates identical run identifiers across sessions', async () => {
    const { tracker, coordinator } = setup();
    const [first, second] = await Promise.all([
      coordinator.start('session-a', request('shared-run', 'session-a')),
      coordinator.start('session-b', request('shared-run', 'session-b')),
    ]);

    expect(
      tracker
        .forSession('session-a', createSessionScope('session-a'))
        .list()
        .map((job) => job.runId),
    ).toEqual(['shared-run']);
    expect(
      tracker
        .forSession('session-b', createSessionScope('session-b'))
        .list()
        .map((job) => job.runId),
    ).toEqual(['shared-run']);
    expect(coordinator.get('session-a', 'shared-run')).toBe(first);
    expect(coordinator.get('session-b', 'shared-run')).toBe(second);
  });

  it('disposes owned handles without closing the host-owned child service', async () => {
    const { service, coordinator } = setup();
    await coordinator.start('session-a', request('run-a', 'session-a'));

    await coordinator.close();
    await coordinator.close();

    expect(service.handles.get('run-a')?.disposeCalls).toBe(1);
    expect(service.closeCalls).toBe(0);
    expect(coordinator.get('session-a', 'run-a')).toBeUndefined();
  });
  it('rejects new children after shutdown', async () => {
    const { coordinator } = setup();
    await coordinator.close();

    await expect(coordinator.start('session-a', request('run-a', 'session-a'))).rejects.toThrow(
      'native Team run coordinator is closed',
    );
  });

  it('disposes a child when shutdown wins an in-flight start', async () => {
    const { service, coordinator } = setup();
    const originalStart = service.start.bind(service);
    let releaseStart!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    service.start = async (childRequest) => {
      await gate;
      return originalStart(childRequest);
    };

    const starting = coordinator.start('session-a', request('run-a', 'session-a'));
    await Promise.resolve();
    await coordinator.close();
    releaseStart();

    await expect(starting).rejects.toThrow('closed during child startup');
    expect(service.handles.get('run-a')?.disposeCalls).toBe(1);
    expect(coordinator.get('session-a', 'run-a')).toBeUndefined();
  });

  it('rejects missing session identity and missing child providers', async () => {
    const { tracker } = setup();
    const withoutProvider = new NativeRunCoordinator(undefined, tracker);

    await expect(withoutProvider.start('', request('run-a', 'session-a'))).rejects.toThrow('session identity');
    await expect(withoutProvider.start('session-a', request('run-a', 'session-a'))).rejects.toThrow(
      'child-session service is unavailable',
    );
  });

  it('cleans up a child when run registration cannot subscribe', async () => {
    const { service, coordinator } = setup();
    const originalStart = service.start.bind(service);
    service.start = async (childRequest) => {
      const handle = (await originalStart(childRequest)) as FakeHandle;
      handle.subscribeFailure = new Error('subscribe failed');
      return handle;
    };

    await expect(coordinator.start('session-a', request('run-a', 'session-a'))).rejects.toThrow('subscribe failed');
    expect(service.handles.get('run-a')?.disposeCalls).toBe(1);
    expect(coordinator.get('session-a', 'run-a')).toBeUndefined();
  });

  it('reports aggregate shutdown failures after releasing every run', async () => {
    const { service, coordinator } = setup();
    await coordinator.start('session-a', request('run-a', 'session-a'));
    await coordinator.start('session-a', request('run-b', 'session-a'));
    service.handles.get('run-a')!.disposeFailure = new Error('dispose a');
    service.handles.get('run-b')!.disposeFailure = new Error('dispose b');

    await expect(coordinator.close()).rejects.toThrow('Native Team run shutdown failed');
    expect(coordinator.get('session-a', 'run-a')).toBeUndefined();
    expect(coordinator.get('session-a', 'run-b')).toBeUndefined();
  });

  it('rejects control for missing native runs', async () => {
    const { coordinator } = setup();

    await expect(coordinator.steer('session-a', 'missing', 'continue')).rejects.toThrow('No active native run');
    await expect(coordinator.stop('session-a', 'missing')).rejects.toThrow('No active native run');
  });

  it('projects session ownership and a default completion summary', async () => {
    const { service, tracker, notifier, coordinator } = setup();
    await coordinator.start('session-a', request('run-a', 'session-a'));
    service.handles.get('run-a')!.emit({
      runId: 'run-a',
      state: 'completed',
      timestamp: 25,
      sessionFile: '/sessions/run-a.jsonl',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(coordinator.status('session-a', 'run-a')).toMatchObject({
      status: 'completed',
      sessionFile: '/sessions/run-a.jsonl',
    });
    expect(coordinator.status('session-a', 'run-a')?.summary).toBeUndefined();
    expect(coordinator.status('session-b', 'run-a')).toBeUndefined();
    expect(tracker.getNative('session-a', 'run-a')?.error).toBeUndefined();
    expect(notifier.results[0]).toMatchObject({
      summary: 'Native child run completed.',
      sessionFile: '/sessions/run-a.jsonl',
    });
  });

  it('projects provider failure events without polling a status file', async () => {
    const { service, tracker, notifier, coordinator } = setup();
    await coordinator.start('session-a', request('run-a', 'session-a'));
    service.handles.get('run-a')!.emit({ runId: 'run-a', state: 'failed', timestamp: 25, message: 'boom' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(tracker.getNative('session-a', 'run-a')).toMatchObject({ status: 'failed', error: 'boom' });
    expect(notifier.results[0]).toMatchObject({ success: false, summary: 'boom' });
  });
});
