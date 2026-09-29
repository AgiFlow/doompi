import { afterEach, describe, expect, it, vi } from 'vitest';

import { withShutdownDeadline } from '../../src/builders/server/shutdown';

afterEach(() => vi.useRealTimers());

describe('shutdown deadlines', () => {
  it('clears the deadline when a phase succeeds', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    await withShutdownDeadline(close, 'fixture');
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves synchronous and asynchronous failures', async () => {
    const failure = new Error('close failed');
    await expect(
      withShutdownDeadline(() => {
        throw failure;
      }, 'fixture'),
    ).rejects.toBe(failure);
    await expect(withShutdownDeadline(() => Promise.reject(failure), 'fixture')).rejects.toBe(failure);
  });

  it('allows later cleanup after a stalled phase and observes its late rejection', async () => {
    vi.useFakeTimers();
    let rejectLate!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectLate = reject;
    });
    const phases: string[] = [];
    const shutdown = (async () => {
      try {
        await withShutdownDeadline(() => pending, 'session', 20);
      } catch (error) {
        phases.push((error as Error).message);
      }
      await withShutdownDeadline(
        () => {
          phases.push('MCP closed');
        },
        'MCP',
        20,
      );
    })();
    await vi.advanceTimersByTimeAsync(20);
    await shutdown;
    rejectLate(new Error('late failure'));
    await Promise.resolve();
    expect(phases).toEqual(['session exceeded 20ms', 'MCP closed']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
