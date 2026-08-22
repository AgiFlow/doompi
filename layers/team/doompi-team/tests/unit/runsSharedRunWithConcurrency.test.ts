import { describe, expect, it, vi } from 'vitest';

import { runWithConcurrency } from '../../src/adapters/runs/shared/runWithConcurrency';

/** Resolves after a macrotask tick, cheap and deterministic enough to order concurrent starts without relying on wall-clock timing. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('runWithConcurrency', () => {
  it('resolves an empty array for zero factories', async () => {
    const results = await runWithConcurrency([], 4);
    expect(results).toEqual([]);
  });

  it('runs every factory and returns fulfilled outcomes in input order', async () => {
    const results = await runWithConcurrency([async () => 'a', async () => 'b', async () => 'c'], 2);

    expect(results).toEqual([
      { status: 'fulfilled', value: 'a' },
      { status: 'fulfilled', value: 'b' },
      { status: 'fulfilled', value: 'c' },
    ]);
  });

  it('reports lifecycle events through a caller-owned reporter', async () => {
    const report = vi.fn();

    await runWithConcurrency(
      [
        async () => 'ok',
        async () => {
          throw new Error('failed');
        },
      ],
      2,
      report,
    );

    expect(report).toHaveBeenNthCalledWith(1, 'doom_team.concurrency_started', {
      'team.task_count': 2,
      'team.concurrency': 2,
    });
    expect(report).toHaveBeenNthCalledWith(2, 'doom_team.concurrency_finished', {
      'team.task_count': 2,
      'team.concurrency': 2,
      'team.failure_count': 1,
      duration_ms: expect.any(Number),
      outcome: 'completed',
    });
  });

  it('never has more than `concurrency` factories running at once', async () => {
    let active = 0;
    let maxActive = 0;
    const factories = Array.from({ length: 6 }, (_, i) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick();
      active -= 1;
      return i;
    });

    const results = await runWithConcurrency(factories, 2);

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : undefined))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('one rejection does not abort or block its peers - every outcome still settles', async () => {
    const results = await runWithConcurrency(
      [
        async () => 'ok-1',
        async () => {
          throw new Error('boom');
        },
        async () => 'ok-2',
      ],
      3,
    );

    expect(results[0]).toEqual({ status: 'fulfilled', value: 'ok-1' });
    expect(results[1]).toMatchObject({ status: 'rejected' });
    expect((results[1] as { status: 'rejected'; reason: unknown }).reason).toBeInstanceOf(Error);
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'ok-2' });
  });

  it('a slot freed by a rejection is reused for the next queued factory (settle-all keeps going, not just tolerates)', async () => {
    const started: number[] = [];
    const factories = [
      async () => {
        started.push(0);
        throw new Error('first fails immediately');
      },
      async () => {
        started.push(1);
        return 'second';
      },
    ];

    const results = await runWithConcurrency(factories, 1);

    expect(started).toEqual([0, 1]);
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'second' });
  });

  it('a concurrency higher than the factory count does not throw or hang', async () => {
    const results = await runWithConcurrency([async () => 1], 100);
    expect(results).toEqual([{ status: 'fulfilled', value: 1 }]);
  });

  it('a concurrency of 0 or negative still runs everything, at concurrency 1', async () => {
    const results = await runWithConcurrency([async () => 1, async () => 2], 0);
    expect(results).toEqual([
      { status: 'fulfilled', value: 1 },
      { status: 'fulfilled', value: 2 },
    ]);
  });
});
