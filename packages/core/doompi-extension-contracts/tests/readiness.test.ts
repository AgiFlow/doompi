import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import {
  createDoomReadinessCoordinator,
  DOOM_READINESS_ERROR_CODE,
  DOOM_READINESS_SERVICE,
  DoomReadinessError,
  readDoomReadinessCoordinator,
  requireDoomReadinessCoordinator,
} from '../src/schemas/readiness.ts';

function deferred<TValue>(): {
  readonly promise: Promise<TValue>;
  readonly resolve: (value: TValue) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve = (_value: TValue): void => undefined;
  let reject = (_error: unknown): void => undefined;
  const promise = new Promise<TValue>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('Doom readiness coordinator', () => {
  it('publishes pending and ready snapshots while preserving typed values', async () => {
    const completion = deferred<{ value: { registrySize: number } }>();
    const coordinator = createDoomReadinessCoordinator();
    let taskSignal: AbortSignal | undefined;
    const handle = coordinator.start('@agimon-ai/doompi-workflow', 'session:1', (signal) => {
      taskSignal = signal;
      return completion.promise;
    });

    expect(handle.snapshot()).toEqual({
      packageId: '@agimon-ai/doompi-workflow',
      generation: 'session:1',
      state: 'pending',
      diagnostics: [],
    });
    expect(coordinator.read('@agimon-ai/doompi-workflow')).toEqual(handle.snapshot());
    expect(coordinator.snapshots()).toEqual([handle.snapshot()]);

    await settleMicrotasks();
    expect(taskSignal).toBeInstanceOf(AbortSignal);
    completion.resolve({ value: { registrySize: 12 } });
    await expect(handle.wait()).resolves.toEqual({ registrySize: 12 });
    expect(handle.snapshot()).toMatchObject({ state: 'ready', diagnostics: [] });
    expect(Object.isFrozen(handle.snapshot())).toBe(true);
    expect(Object.isFrozen(handle.snapshot().diagnostics)).toBe(true);
    await coordinator.dispose();
  });

  it('returns degraded values and notifies exactly once with immutable diagnostics', async () => {
    const notify = vi.fn();
    const coordinator = createDoomReadinessCoordinator({ notify });
    const handle = coordinator.start('voice', 'generation-1', async () => ({
      value: 'fallback-engine',
      diagnostics: ['Local engine unavailable; using fallback.'],
    }));

    await expect(handle.wait()).resolves.toBe('fallback-engine');
    expect(handle.snapshot()).toEqual({
      packageId: 'voice',
      generation: 'generation-1',
      state: 'degraded',
      diagnostics: ['Local engine unavailable; using fallback.'],
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toEqual(handle.snapshot());
    expect(Object.isFrozen(notify.mock.calls[0]?.[0])).toBe(true);
    handle.snapshot();
    coordinator.snapshots();
    expect(notify).toHaveBeenCalledTimes(1);
    await coordinator.dispose();
  });

  it('wraps synchronous and asynchronous task failures with stable codes and causes', async () => {
    const notify = vi.fn();
    const coordinator = createDoomReadinessCoordinator({ notify });
    const cause = new Error('registry scan failed');
    const rejected = coordinator.start('runner', 'generation-1', async () => {
      throw cause;
    });

    await expect(rejected.wait()).rejects.toMatchObject({
      name: 'DoomReadinessError',
      code: DOOM_READINESS_ERROR_CODE.failed,
      packageId: 'runner',
      generation: 'generation-1',
      cause,
    });
    expect(rejected.snapshot()).toMatchObject({
      state: 'failed',
      error: { code: DOOM_READINESS_ERROR_CODE.failed, message: expect.stringContaining('registry scan failed') },
    });
    expect(notify).toHaveBeenCalledTimes(1);

    const synchronous = coordinator.start('hooks', 'generation-1', (() => {
      throw new Error('document load failed');
    }) as never);
    await expect(synchronous.wait()).rejects.toMatchObject({ code: DOOM_READINESS_ERROR_CODE.failed });
    expect(notify).toHaveBeenCalledTimes(2);
    await coordinator.dispose();
  });

  it('observes rejected background work before a caller waits for it', async () => {
    const coordinator = createDoomReadinessCoordinator();
    const handle = coordinator.start('log', 'generation-1', async () => {
      throw new Error('sink unavailable');
    });

    await vi.waitFor(() => expect(handle.snapshot().state).toBe('failed'));
    await expect(handle.wait()).rejects.toMatchObject({ code: DOOM_READINESS_ERROR_CODE.failed });
    await coordinator.dispose();
  });

  it('rejects duplicate live work but permits a new generation after settlement', async () => {
    const firstCompletion = deferred<{ value: number }>();
    const coordinator = createDoomReadinessCoordinator();
    const first = coordinator.start('workflow', 'generation-1', () => firstCompletion.promise);

    expect(() => coordinator.start('workflow', 'generation-2', async () => ({ value: 2 }))).toThrowError(
      expect.objectContaining({ code: DOOM_READINESS_ERROR_CODE.duplicate }),
    );
    firstCompletion.resolve({ value: 1 });
    await expect(first.wait()).resolves.toBe(1);

    const second = coordinator.start('workflow', 'generation-2', async () => ({ value: 2 }));
    await expect(second.wait()).resolves.toBe(2);
    expect(coordinator.read('workflow')?.generation).toBe('generation-2');
    expect(first.snapshot()).toMatchObject({ generation: 'generation-1', state: 'ready' });
    await coordinator.dispose();
  });

  it('aborts one waiter without cancelling shared package initialization', async () => {
    const completion = deferred<{ value: string }>();
    const coordinator = createDoomReadinessCoordinator();
    const handle = coordinator.start('team', 'generation-1', () => completion.promise);
    const controller = new AbortController();
    const waiting = handle.wait({ signal: controller.signal });

    controller.abort(new Error('tool invocation cancelled'));
    await expect(waiting).rejects.toMatchObject({
      code: DOOM_READINESS_ERROR_CODE.waitAborted,
      packageId: 'team',
      generation: 'generation-1',
    });
    expect(handle.snapshot().state).toBe('pending');

    const alreadyAborted = new AbortController();
    alreadyAborted.abort('caller stopped');
    await expect(handle.wait({ signal: alreadyAborted.signal })).rejects.toMatchObject({
      code: DOOM_READINESS_ERROR_CODE.waitAborted,
      cause: 'caller stopped',
    });
    completion.resolve({ value: 'ready' });
    await expect(handle.wait()).resolves.toBe('ready');
    await coordinator.dispose();
  });

  it('cancels pending generations immediately and awaits every underlying task during disposal', async () => {
    const firstCompletion = deferred<{ value: string }>();
    const secondCompletion = deferred<{ value: string }>();
    const coordinator = createDoomReadinessCoordinator();
    let firstSignal: AbortSignal | undefined;
    const first = coordinator.start('runner', 'generation-1', (signal) => {
      firstSignal = signal;
      return firstCompletion.promise;
    });
    const second = coordinator.start('workflow', 'generation-1', () => secondCompletion.promise);
    await settleMicrotasks();

    const disposal = coordinator.dispose();
    const repeatedDisposal = coordinator.dispose();
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    expect(repeatedDisposal).toBe(disposal);
    expect(firstSignal?.aborted).toBe(true);
    await expect(first.wait()).rejects.toMatchObject({ code: DOOM_READINESS_ERROR_CODE.cancelled });
    await expect(second.wait()).rejects.toMatchObject({ code: DOOM_READINESS_ERROR_CODE.cancelled });
    expect(first.snapshot().state).toBe('cancelled');
    expect(disposed).toBe(false);

    firstCompletion.resolve({ value: 'stale-runner' });
    await settleMicrotasks();
    expect(first.snapshot().state).toBe('cancelled');
    expect(disposed).toBe(false);
    secondCompletion.resolve({ value: 'stale-workflow' });
    await disposal;
    expect(disposed).toBe(true);
    expect(coordinator.snapshots().map(({ state }) => state)).toEqual(['cancelled', 'cancelled']);

    expect(() => coordinator.start('new-package', 'generation-2', async () => ({ value: true }))).toThrowError(
      expect.objectContaining({ code: DOOM_READINESS_ERROR_CODE.disposed }),
    );
  });

  it('turns invalid task results into failures without publishing partial values', async () => {
    const coordinator = createDoomReadinessCoordinator();
    const missingValue = coordinator.start('goal', 'generation-1', async () => ({ diagnostics: [] }) as never);
    await expect(missingValue.wait()).rejects.toMatchObject({ code: DOOM_READINESS_ERROR_CODE.failed });

    const invalidDiagnostics = coordinator.start(
      'goal',
      'generation-2',
      async () =>
        ({
          value: 'partial',
          diagnostics: [1],
        }) as never,
    );
    await expect(invalidDiagnostics.wait()).rejects.toMatchObject({ code: DOOM_READINESS_ERROR_CODE.failed });
    expect(invalidDiagnostics.snapshot()).toMatchObject({ state: 'failed', diagnostics: [] });
    await coordinator.dispose();
  });

  it('validates identities and task inputs with stable invalid-argument errors', async () => {
    const coordinator = createDoomReadinessCoordinator();
    for (const start of [
      () => coordinator.start('', 'generation-1', async () => ({ value: true })),
      () => coordinator.start('runner', '', async () => ({ value: true })),
      () => coordinator.start('runner', 'generation-1', undefined as never),
    ]) {
      expect(start).toThrowError(expect.objectContaining({ code: DOOM_READINESS_ERROR_CODE.invalidArgument }));
    }
    expect(coordinator.snapshots()).toEqual([]);
    await coordinator.dispose();
  });

  it('resolves the coordinator through the shared Cordis root', async () => {
    const root = new Context();
    const coordinator = createDoomReadinessCoordinator();
    expect(readDoomReadinessCoordinator(root)).toBeUndefined();
    expect(() => requireDoomReadinessCoordinator(root)).toThrowError(
      expect.objectContaining({ code: DOOM_READINESS_ERROR_CODE.unavailable }),
    );

    const unpublish = root.reflect.provide(DOOM_READINESS_SERVICE, coordinator) as unknown as () => Promise<void>;
    expect(readDoomReadinessCoordinator(root)).toBe(coordinator);
    expect(requireDoomReadinessCoordinator(root)).toBe(coordinator);

    await unpublish();
    expect(readDoomReadinessCoordinator(root)).toBeUndefined();
    await coordinator.dispose();
    await root.fiber.dispose();
  });

  it('exports an identifiable error class for cross-package handling', () => {
    const error = new DoomReadinessError(DOOM_READINESS_ERROR_CODE.failed, 'failed', {
      packageId: 'workflow',
      generation: 'generation-1',
    });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DoomReadinessError);
    expect(error).toMatchObject({
      name: 'DoomReadinessError',
      code: DOOM_READINESS_ERROR_CODE.failed,
      packageId: 'workflow',
      generation: 'generation-1',
    });
  });
});
