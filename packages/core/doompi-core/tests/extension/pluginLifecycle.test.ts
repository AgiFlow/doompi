import { describe, expect, it, vi } from 'vitest';
import { createPluginLifecycle } from '../../src/services/pluginLifecycle';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('plugin lifecycle', () => {
  it('awaits registration and startup, then stops and removes registrations in reverse order', async () => {
    const events: string[] = [];
    const lifecycle = createPluginLifecycle((signal) => ({ signal }));
    const ready = deferred();
    const entered = deferred();
    const mount = lifecycle.mount(
      {
        async onStart(context) {
          expect(context).toBe(lifecycle.context);
          events.push('start');
          entered.resolve();
          await ready.promise;
        },
        onStop({ signal }) {
          expect(signal.aborted).toBe(true);
          events.push('stop');
        },
        onDispose() {
          events.push('dispose');
        },
      },
      async () => {
        events.push('register');
        lifecycle.own(() => {
          events.push('first');
        });
        await Promise.resolve();
        lifecycle.own(() => {
          events.push('second');
        });
      },
    );
    let mounted = false;
    void mount.then(() => {
      mounted = true;
    });
    await entered.promise;
    expect(mounted).toBe(false);
    ready.resolve();
    await mount;
    const disposal = lifecycle.dispose();
    expect(lifecycle.dispose()).toBe(disposal);
    await disposal;
    expect(events).toEqual(['register', 'start', 'stop', 'second', 'first', 'dispose']);
  });

  it('rolls back partial registration without starting or stopping', async () => {
    const lifecycle = createPluginLifecycle((signal) => ({ signal }));
    const cleanup = vi.fn();
    const onStart = vi.fn();
    const onStop = vi.fn();
    const onDispose = vi.fn();
    const failure = new Error('registration failed');
    await expect(
      lifecycle.mount({ onStart, onStop, onDispose }, () => {
        lifecycle.own(cleanup);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(onStart).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(onDispose).toHaveBeenCalledOnce();
  });

  it('preserves startup and every cleanup failure while completing rollback', async () => {
    const lifecycle = createPluginLifecycle((signal) => ({ signal }));
    const failure = new Error('start');
    const stopFailure = new Error('stop');
    const cleanupFailure = new Error('cleanup');
    const disposeFailure = new Error('dispose');
    const clean = vi.fn();
    const mount = lifecycle.mount(
      {
        onStart() {
          throw failure;
        },
        onStop() {
          throw stopFailure;
        },
        onDispose() {
          throw disposeFailure;
        },
      },
      () => {
        lifecycle.own(clean);
        lifecycle.own(() => {
          throw cleanupFailure;
        });
      },
    );
    await expect(mount).rejects.toMatchObject({
      cause: failure,
      errors: [failure, stopFailure, cleanupFailure, disposeFailure],
    });
    expect(clean).toHaveBeenCalledOnce();
    await expect(lifecycle.dispose()).rejects.toMatchObject({ errors: [stopFailure, cleanupFailure, disposeFailure] });
    expect(clean).toHaveBeenCalledOnce();
  });

  it('aborts immediately during startup and waits for it before stopping', async () => {
    const lifecycle = createPluginLifecycle((signal) => ({ signal }));
    const entered = deferred();
    const finish = deferred();
    const events: string[] = [];
    const mount = lifecycle.mount(
      {
        async onStart() {
          entered.resolve();
          await finish.promise;
          events.push('started');
        },
        onStop() {
          events.push('stopped');
        },
      },
      () => {
        lifecycle.own(() => {
          events.push('removed');
        });
      },
    );
    const rejected = expect(mount).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    const disposal = lifecycle.dispose();
    expect(lifecycle.context.signal.aborted).toBe(true);
    expect(events).toEqual([]);
    finish.resolve();
    await Promise.all([disposal, rejected]);
    expect(events).toEqual(['started', 'stopped', 'removed']);
  });

  it('collects registrations completed during shutdown without starting', async () => {
    const lifecycle = createPluginLifecycle((signal) => ({ signal }));
    const entered = deferred();
    const finish = deferred();
    const cleanup = vi.fn();
    const onStart = vi.fn();
    const mount = lifecycle.mount({ onStart }, async () => {
      entered.resolve();
      await finish.promise;
      lifecycle.own(cleanup);
    });
    const rejected = expect(mount).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    const disposal = lifecycle.dispose();
    finish.resolve();
    await Promise.all([disposal, rejected]);
    expect(onStart).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('supports empty declarations, rejects remounting, and isolates instances', async () => {
    const first = createPluginLifecycle((signal) => ({ signal }));
    const second = createPluginLifecycle((signal) => ({ signal }));
    await Promise.all([first.mount({}, () => {}), second.mount({}, () => {})]);
    await first.dispose();
    expect(second.context.signal.aborted).toBe(false);
    expect(() => first.own(() => {})).toThrow('after plugin cleanup begins');
    await expect(first.mount({}, () => {})).rejects.toThrow('only mount once');
    await second.dispose();
  });

  it('shares shutdown with abort listeners that request disposal again', async () => {
    const lifecycle = createPluginLifecycle((signal) => ({ signal }));
    const cleanup = vi.fn();
    let reentrant: Promise<void> | undefined;
    lifecycle.context.signal.addEventListener(
      'abort',
      () => {
        reentrant = lifecycle.dispose();
      },
      { once: true },
    );
    await lifecycle.mount({}, () => {
      lifecycle.own(cleanup);
    });
    const disposal = lifecycle.dispose();
    expect(reentrant).toBe(disposal);
    await disposal;
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('stops a mounted plugin when its optional start hook is absent', async () => {
    const lifecycle = createPluginLifecycle((signal) => ({ signal }));
    const onStop = vi.fn();
    await lifecycle.mount({ onStop }, () => {});
    await lifecycle.dispose();
    expect(onStop).toHaveBeenCalledOnce();
  });
});

it('awaits asynchronous discovery and cleans returned state if disposal interrupts it', async () => {
  const lifecycle = createPluginLifecycle((signal) => ({ signal }));
  const entered = deferred();
  const discovered = deferred();
  const register = vi.fn();
  const onStart = vi.fn();
  const onStop = vi.fn();
  const onDispose = vi.fn();
  const mount = lifecycle.mount(async () => {
    entered.resolve();
    await discovered.promise;
    return { onStart, onStop, onDispose };
  }, register);
  const rejected = expect(mount).rejects.toMatchObject({ name: 'AbortError' });
  await entered.promise;
  const disposal = lifecycle.dispose();
  expect(lifecycle.context.signal.aborted).toBe(true);
  discovered.resolve();
  await rejected;
  await disposal;
  expect(register).not.toHaveBeenCalled();
  expect(onStart).not.toHaveBeenCalled();
  expect(onStop).not.toHaveBeenCalled();
  expect(onDispose).toHaveBeenCalledOnce();
});

it('surfaces discovery rejection and releases previously owned host resources', async () => {
  const lifecycle = createPluginLifecycle((signal) => ({ signal }));
  const cleanup = vi.fn();
  const register = vi.fn();
  const failure = new Error('discovery failed');
  lifecycle.own(cleanup);
  await expect(
    lifecycle.mount(async () => {
      throw failure;
    }, register),
  ).rejects.toBe(failure);
  expect(lifecycle.context.signal.aborted).toBe(true);
  expect(register).not.toHaveBeenCalled();
  expect(cleanup).toHaveBeenCalledOnce();
});
