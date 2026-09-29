import { describe, expect, it, vi } from 'vitest';

import { createExecutionBudget } from '../../src/builders/server/executionBudget';

describe('host execution budget', () => {
  it('shares a FIFO limit and releases a slot only once', async () => {
    const budget = createExecutionBudget(1);
    const first = await budget.acquire();
    const order: number[] = [];
    const second = budget.acquire().then((release) => {
      order.push(2);
      return release;
    });
    const third = budget.acquire().then((release) => {
      order.push(3);
      return release;
    });
    expect(budget.getSnapshot()).toEqual({ running: 1, queued: 2, limit: 1 });
    first();
    first();
    const releaseSecond = await second;
    expect(order).toEqual([2]);
    expect(budget.getSnapshot()).toEqual({ running: 1, queued: 1, limit: 1 });
    releaseSecond();
    const releaseThird = await third;
    expect(order).toEqual([2, 3]);
    releaseThird();
    expect(budget.getSnapshot()).toEqual({ running: 0, queued: 0, limit: 1 });
    budget.close();
  });

  it("removes a cancelled waiter without stealing another caller's slot", async () => {
    const budget = createExecutionBudget(1);
    const running = await budget.acquire();
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const cancelled = budget.acquire(controller.signal);
    const rejection = expect(cancelled).rejects.toThrow('cancel queued job');
    const survivor = budget.acquire();
    controller.abort(new Error('cancel queued job'));
    await rejection;
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(budget.getSnapshot().queued).toBe(1);
    running();
    (await survivor)();
    budget.close();
  });

  it('rejects pre-cancelled requests without allocating a slot', async () => {
    const budget = createExecutionBudget();
    await expect(budget.acquire(AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
    expect(budget.getSnapshot().running).toBe(0);
    budget.close();
  });

  it('rejects queued and new work on shutdown without releasing active owners', async () => {
    const budget = createExecutionBudget(1);
    const running = await budget.acquire();
    const pending = expect(budget.acquire()).rejects.toThrow('closed');
    budget.close();
    budget.close();
    await pending;
    await expect(budget.acquire()).rejects.toThrow('closed');
    expect(budget.getSnapshot()).toEqual({ running: 1, queued: 0, limit: 1 });
    running();
    expect(budget.getSnapshot().running).toBe(0);
  });

  it('bounds the waiting queue', async () => {
    const budget = createExecutionBudget(1);
    const running = await budget.acquire();
    const pending = Array.from({ length: 128 }, () => budget.acquire().catch(() => undefined));
    await expect(budget.acquire()).rejects.toThrow('queue is full');
    budget.close();
    await Promise.all(pending);
    running();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid limit %s', (limit) => {
    expect(() => createExecutionBudget(limit)).toThrow('positive integer');
  });
});
