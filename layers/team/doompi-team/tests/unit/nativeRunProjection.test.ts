import { describe, expect, it, vi } from 'vitest';

import type { NativeAsyncJobProjection } from '../../src/services/asyncJobTracker';
import { nativeRunProjection, subscribeNativeRunProjection } from '../../src/services/nativeRunProjection';

function run(runId: string, status = 'running'): NativeAsyncJobProjection {
  return {
    runId,
    agent: 'worker',
    task: 'inspect projection',
    cwd: '/workspace',
    runtime: 'pi',
    status,
    startedAt: 1,
    updatedAt: 2,
  };
}

describe('nativeRunProjection', () => {
  it('publishes session snapshots and immediately hydrates later subscribers', () => {
    const sessionId = 'projection-publish';
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeNativeRunProjection(sessionId, first);

    nativeRunProjection.publish(sessionId, run('run-1'));
    nativeRunProjection.publish(sessionId, run('run-2', 'completed'));
    const unsubscribeSecond = subscribeNativeRunProjection(sessionId, second);

    expect(first).toHaveBeenNthCalledWith(1, [run('run-1')]);
    expect(first).toHaveBeenNthCalledWith(2, [run('run-1'), run('run-2', 'completed')]);
    expect(second).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith([run('run-1'), run('run-2', 'completed')]);

    unsubscribeFirst();
    unsubscribeFirst();
    nativeRunProjection.publish(sessionId, run('run-2', 'failed'));
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenLastCalledWith([run('run-1'), run('run-2', 'failed')]);

    nativeRunProjection.dispose(sessionId);
    expect(second).toHaveBeenLastCalledWith([]);
    unsubscribeSecond();
  });

  it('cleans up empty subscriptions and treats disposal of an unknown session as a no-op', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNativeRunProjection('projection-empty', listener);

    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    nativeRunProjection.dispose('projection-empty');
    expect(listener).not.toHaveBeenCalled();
  });
});
