import type { LoopLaunchRequest, StoppableLoop } from '@agimon-ai/doompi-extension-contracts/loop-launchers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDoomLoopLaunchersService } from '../src/services/loopLaunchers.ts';

let sequence = 0;

function createService(generation = `loop-test-${++sequence}`) {
  let instanceSequence = 0;
  return createDoomLoopLaunchersService({
    generation,
    createInstanceId: () => `${generation}:instance:${++instanceSequence}`,
    timestamp: () => '2026-08-20T12:34:56.000Z',
  });
}

const handle = (instanceId: string, stop = vi.fn()): StoppableLoop => ({
  instanceId,
  label: 'Test loop',
  stop,
});

describe('Doom loop-launchers service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('tracks multiple instances under its provider generation', async () => {
    const service = createService('session-one:loop-launchers');
    const launch = vi.fn(async ({ instanceId }: LoopLaunchRequest) => handle(instanceId));
    const registration = service.register({
      id: 'test.launcher',
      source: 'test',
      label: 'Test launcher',
      launch,
    });

    expect(service.generation).toBe('session-one:loop-launchers');
    expect(registration.generation).toBe('session-one:loop-launchers:launcher:1');
    await service.launch('test.launcher', { instanceId: 'one' });
    await service.launch('test.launcher', { instanceId: 'two' });

    expect(service.listInstances()).toEqual([
      expect.objectContaining({ instanceId: 'one', state: 'running' }),
      expect.objectContaining({ instanceId: 'two', state: 'running' }),
    ]);
    await registration.dispose();
    expect(service.listInstances()).toEqual([]);
    await service.dispose();
  });

  it('rejects duplicate launcher and instance ids', async () => {
    const service = createService();
    const registration = service.register({
      id: 'duplicate',
      source: 'first',
      label: 'First',
      launch: async ({ instanceId }) => handle(instanceId),
    });
    expect(() =>
      service.register({
        id: 'duplicate',
        source: 'second',
        label: 'Second',
        launch: async ({ instanceId }) => handle(instanceId),
      }),
    ).toThrow('already registered');
    await service.launch('duplicate', { instanceId: 'same' });
    await expect(service.launch('duplicate', { instanceId: 'same' })).rejects.toThrow('already exists');
    await registration.dispose();
    await service.dispose();
  });

  it('isolates independently owned session services', async () => {
    const first = createService('first');
    const second = createService('second');
    const registration = first.register({
      id: 'isolated',
      source: 'test',
      label: 'Isolated',
      launch: async ({ instanceId }) => handle(instanceId),
    });

    expect(first.listLaunchers()).toHaveLength(1);
    expect(second.listLaunchers()).toEqual([]);
    await expect(second.launch('isolated')).rejects.toThrow("launcher 'isolated' is unavailable");
    await registration.dispose();
    await Promise.all([first.dispose(), second.dispose()]);
  });

  it('releases cancelled reservations', async () => {
    const service = createService();
    const registration = service.register({
      id: 'cancel',
      source: 'test',
      label: 'Cancel',
      launch: async () => undefined,
    });

    await expect(service.launch('cancel', { instanceId: 'reusable' })).resolves.toBeUndefined();
    await expect(service.launch('cancel', { instanceId: 'reusable' })).resolves.toBeUndefined();
    await registration.dispose();
    await service.dispose();
  });

  it('aborts pending input and stops a handle returned late', async () => {
    const service = createService();
    let resolveLaunch: ((value: StoppableLoop) => void) | undefined;
    let request: LoopLaunchRequest | undefined;
    const stop = vi.fn();
    const registration = service.register({
      id: 'late',
      source: 'test',
      label: 'Late',
      launch: async (nextRequest) => {
        request = nextRequest;
        return new Promise<StoppableLoop>((resolve) => {
          resolveLaunch = resolve;
        });
      },
    });
    const pending = service.launch('late', { instanceId: 'pending' });
    await vi.waitFor(() => expect(request).toBeDefined());

    await service.stop('pending', 'cancel');
    expect(request?.signal.aborted).toBe(true);
    if (!resolveLaunch) throw new Error('Expected pending launcher resolver.');
    resolveLaunch(handle('pending', stop));

    await expect(pending).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
    await registration.dispose();
    await service.dispose();
  });

  it('stops mismatched handles and removes failed cleanup entries', async () => {
    const service = createService();
    const mismatchStop = vi.fn();
    const mismatch = service.register({
      id: 'mismatch',
      source: 'test',
      label: 'Mismatch',
      launch: async () => handle('wrong', mismatchStop),
    });
    await expect(service.launch('mismatch', { instanceId: 'expected' })).rejects.toThrow('mismatched');
    expect(mismatchStop).toHaveBeenCalledOnce();
    await mismatch.dispose();

    const failure = service.register({
      id: 'failure',
      source: 'test',
      label: 'Failure',
      launch: async ({ instanceId }) =>
        handle(
          instanceId,
          vi.fn(async () => Promise.reject(new Error('cleanup failed'))),
        ),
    });
    await service.launch('failure', { instanceId: 'failure-instance' });
    await expect(service.stop('failure-instance')).rejects.toThrow('cleanup failed');
    expect(service.listInstances()).toEqual([]);
    await failure.dispose();
    await service.dispose();
  });

  it('notifies subscribers and makes unsubscription and stop idempotent', async () => {
    const service = createService();
    const stop = vi.fn();
    const registration = service.register({
      id: 'events',
      source: 'test',
      label: 'Events',
      launch: async ({ instanceId }) => handle(instanceId, stop),
    });
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    await service.launch('events', { instanceId: 'instance' });

    await expect(service.stop('instance')).resolves.toBe(true);
    await expect(service.stop('instance')).resolves.toBe(false);
    expect(stop).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    unsubscribe();
    await registration.dispose();
    await service.dispose();
  });

  it('uses injected identity and time dependencies', async () => {
    const service = createService('deterministic');
    const registration = service.register({
      id: 'available',
      source: 'test',
      label: 'Available',
      description: 'Deterministic launcher',
      launch: async ({ instanceId }) => handle(instanceId),
    });

    expect(service.listLaunchers()).toEqual([
      expect.objectContaining({ id: 'available', description: 'Deterministic launcher' }),
    ]);
    await expect(service.launch('available')).resolves.toMatchObject({
      instanceId: 'deterministic:instance:1',
      startedAt: '2026-08-20T12:34:56.000Z',
    });
    await registration.dispose();
    await service.dispose();
  });

  it('validates generation, launcher, and instance identifiers', async () => {
    expect(() =>
      createDoomLoopLaunchersService({ generation: '', createInstanceId: () => 'id', timestamp: () => 'now' }),
    ).toThrow('valid generation');
    const service = createService();
    expect(() =>
      service.register({ id: '\n', source: 'test', label: 'Invalid', launch: async () => undefined }),
    ).toThrow('Invalid loop launcher id');

    const registration = service.register({
      id: 'valid',
      source: 'test',
      label: 'Valid',
      launch: async ({ instanceId }) => handle(instanceId),
    });
    await expect(service.launch('valid', { instanceId: '\u007f' })).rejects.toThrow('Invalid loop instance id');
    await registration.dispose();
    await service.dispose();
  });

  it('stops all instances when the Cordis provider is lost', async () => {
    const service = createService();
    const stop = vi.fn();
    const registration = service.register({
      id: 'provider-owned',
      source: 'test',
      label: 'Provider owned',
      launch: async ({ instanceId }) => handle(instanceId, stop),
    });
    await service.launch('provider-owned', { instanceId: 'one' });
    await service.launch('provider-owned', { instanceId: 'two' });

    await service.dispose('provider lost');

    expect(stop).toHaveBeenCalledTimes(2);
    expect(() => service.listLaunchers()).toThrow('disposed');
    await expect(service.launch('provider-owned')).rejects.toThrow('disposed');
    await registration.dispose();
  });

  it('makes registration and provider cleanup idempotent', async () => {
    const service = createService();
    const registration = service.register({
      id: 'idempotent',
      source: 'test',
      label: 'Idempotent',
      launch: async ({ instanceId }) => ({ instanceId, detail: 'active', stop: vi.fn() }),
    });
    await service.launch('idempotent', { instanceId: 'cleanup' });

    await service.stopAll('cleanup');
    await registration.dispose();
    await registration.dispose();
    await service.dispose();
    await service.dispose();
    await service.stopAll();
  });

  it('aborts pending launches when their registration is disposed', async () => {
    const service = createService();
    let resolveLaunch: ((value: StoppableLoop) => void) | undefined;
    let signal: AbortSignal | undefined;
    const lateStop = vi.fn();
    const registration = service.register({
      id: 'dispose-pending',
      source: 'test',
      label: 'Dispose pending',
      launch: async (request) => {
        signal = request.signal;
        return new Promise<StoppableLoop>((resolve) => {
          resolveLaunch = resolve;
        });
      },
    });
    const pending = service.launch('dispose-pending', { instanceId: 'pending-dispose' });
    await vi.waitFor(() => expect(signal).toBeDefined());

    const disposing = registration.dispose('provider shutdown');
    expect(signal?.aborted).toBe(true);
    if (!resolveLaunch) throw new Error('Expected pending launcher resolver.');
    resolveLaunch(handle('pending-dispose', lateStop));

    await disposing;
    await expect(pending).resolves.toBeUndefined();
    expect(lateStop).toHaveBeenCalledOnce();
    await service.dispose();
  });
});
