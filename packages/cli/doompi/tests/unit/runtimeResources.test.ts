import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { monitorRuntimeResources, resourceAttributes } from '../../src/builders/server/runtimeResources';

const memory: NodeJS.MemoryUsage = { rss: 1024, heapTotal: 512, heapUsed: 256, external: 128, arrayBuffers: 64 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('bounded runtime resource telemetry', () => {
  it('reports interval CPU rather than cumulative lifetime usage', () => {
    const attributes = resourceAttributes(
      { monotonicMs: 1000, cpu: { user: 9_000_000, system: 1_000_000 }, memory },
      { monotonicMs: 2000, cpu: { user: 9_250_000, system: 1_250_000 }, memory },
    );
    expect(attributes.cpu_percent).toBe(50);
    expect(attributes.cpu_user_ms).toBe(250);
    expect(attributes.cpu_system_ms).toBe(250);
    expect(attributes.rss_bytes).toBe(1024);
    expect(attributes.heap_used_bytes).toBe(256);
  });

  it('keeps zero-duration and reset counters finite', () => {
    const attributes = resourceAttributes(
      { monotonicMs: 0, cpu: { user: 10, system: 10 }, memory },
      { monotonicMs: 0, cpu: { user: 0, system: 0 }, memory },
    );
    expect(attributes.cpu_percent).toBe(0);
    expect(Object.values(attributes).every(Number.isFinite)).toBe(true);
  });

  it('keeps at most one export outstanding and stops its timer on cleanup', async () => {
    let complete: (() => void) | undefined;
    const record = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const stop = monitorRuntimeResources({ record, counts: () => ({ sessions: 100 }), warn: vi.fn(), intervalMs: 10 });
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(record).toHaveBeenCalledOnce();
      expect(record.mock.calls[0]).toBeDefined();
      complete?.();
      await vi.advanceTimersByTimeAsync(10);
      expect(record).toHaveBeenCalledTimes(2);
      stop();
      complete?.();
      await vi.advanceTimersByTimeAsync(100);
      expect(record).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      complete?.();
    }
  });

  it('reports exporter failure without preventing later samples', async () => {
    const record = vi.fn(async () => {
      throw new Error('collector unavailable');
    });
    const warn = vi.fn();
    const stop = monitorRuntimeResources({ record, counts: () => ({}), warn, intervalMs: 10 });
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(record).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('collector unavailable'));
    } finally {
      stop();
    }
  });
});
