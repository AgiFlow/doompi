import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCompletionBatcher,
  resolveCompletionBatchConfig,
} from '../../src/adapters/runs/background/completionBatcher';

const TEST_CONFIG = resolveCompletionBatchConfig({
  debounceMs: 100,
  maxWaitMs: 500,
  stragglerDebounceMs: 50,
  stragglerMaxWaitMs: 200,
  stragglerWindowMs: 1000,
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createCompletionBatcher grouping (fix: a fan-out run must not notify once per child)', () => {
  it('groups three items pushed within the debounce window into a single emit call', () => {
    const emit = vi.fn();
    const batcher = createCompletionBatcher<string>({ config: TEST_CONFIG, emit });

    batcher.push('child-1');
    vi.advanceTimersByTime(30);
    batcher.push('child-2');
    vi.advanceTimersByTime(30);
    batcher.push('child-3');
    vi.advanceTimersByTime(TEST_CONFIG.debounceMs);

    // This is the regression this batcher exists to prevent: three
    // completions must arrive as one call with all three, not three calls.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(['child-1', 'child-2', 'child-3']);
  });

  it('emits a lone item by itself once the debounce elapses with nothing else arriving', () => {
    const emit = vi.fn();
    const batcher = createCompletionBatcher<string>({ config: TEST_CONFIG, emit });

    batcher.push('only-child');
    vi.advanceTimersByTime(TEST_CONFIG.debounceMs);

    expect(emit).toHaveBeenCalledExactlyOnceWith(['only-child']);
  });

  it('resets the debounce on every new arrival, holding the group open', () => {
    const emit = vi.fn();
    const batcher = createCompletionBatcher<string>({ config: TEST_CONFIG, emit });

    batcher.push('a');
    vi.advanceTimersByTime(90); // just under the 100ms debounce
    batcher.push('b'); // resets it
    vi.advanceTimersByTime(90);

    expect(emit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10); // now the (reset) debounce elapses
    expect(emit).toHaveBeenCalledExactlyOnceWith(['a', 'b']);
  });
});

describe('createCompletionBatcher maxWaitMs cap', () => {
  it('emits once maxWaitMs elapses even while the debounce keeps getting reset by new arrivals', () => {
    const emit = vi.fn();
    const batcher = createCompletionBatcher<string>({ config: TEST_CONFIG, emit });

    batcher.push('a');
    // Keep resetting the 100ms debounce every 80ms, well past the 500ms maxWaitMs cap.
    for (let i = 0; i < 7; i++) {
      vi.advanceTimersByTime(80);
      batcher.push(`item-${i}`);
    }

    // maxWaitMs (measured from the first item) must have forced an emit by
    // now regardless of how often the debounce was reset.
    expect(emit).toHaveBeenCalled();
    const emittedItems = emit.mock.calls[0]![0] as string[];
    expect(emittedItems[0]).toBe('a');
  });
});

describe('createCompletionBatcher straggler grouping', () => {
  it('gives an arrival soon after an emit a shorter debounce/max-wait, not the full window', () => {
    const emit = vi.fn();
    const batcher = createCompletionBatcher<string>({ config: TEST_CONFIG, emit });

    batcher.push('first-group');
    vi.advanceTimersByTime(TEST_CONFIG.debounceMs);
    expect(emit).toHaveBeenCalledTimes(1);

    // Arrives well inside the 1000ms straggler window.
    vi.advanceTimersByTime(100);
    batcher.push('straggler');

    // The full (non-straggler) debounce is 100ms; if this were NOT treated as
    // a straggler, it would not have emitted yet at the shorter interval below.
    vi.advanceTimersByTime(TEST_CONFIG.stragglerDebounceMs);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith(['straggler']);
  });

  it('treats an arrival after the straggler window has elapsed as a fresh group, not a straggler', () => {
    const emit = vi.fn();
    const batcher = createCompletionBatcher<string>({ config: TEST_CONFIG, emit });

    batcher.push('first-group');
    vi.advanceTimersByTime(TEST_CONFIG.debounceMs);
    expect(emit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(TEST_CONFIG.stragglerWindowMs + 1);
    batcher.push('later-item');
    vi.advanceTimersByTime(TEST_CONFIG.stragglerDebounceMs);

    // Too late to be a straggler: the shorter straggler debounce is not
    // enough on its own, only the full debounce is.
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TEST_CONFIG.debounceMs);
    expect(emit).toHaveBeenCalledTimes(2);
  });
});

describe('createCompletionBatcher.flush', () => {
  it('emits whatever is held immediately, without waiting out the debounce', () => {
    const emit = vi.fn();
    const batcher = createCompletionBatcher<string>({ config: TEST_CONFIG, emit });

    batcher.push('a');
    batcher.flush();

    expect(emit).toHaveBeenCalledExactlyOnceWith(['a']);
  });

  it('is a no-op when nothing is held', () => {
    const emit = vi.fn();
    const batcher = createCompletionBatcher<string>({ config: TEST_CONFIG, emit });

    batcher.flush();

    expect(emit).not.toHaveBeenCalled();
  });

  it('cancels the pending timers, so a later tick cannot double-emit the same group', () => {
    const emit = vi.fn();
    const batcher = createCompletionBatcher<string>({ config: TEST_CONFIG, emit });

    batcher.push('a');
    batcher.flush();
    vi.advanceTimersByTime(TEST_CONFIG.maxWaitMs);

    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe('createCompletionBatcher.dispose', () => {
  it('returns items that were never emitted, without emitting them', () => {
    const emit = vi.fn();
    const batcher = createCompletionBatcher<string>({ config: TEST_CONFIG, emit });

    batcher.push('a');
    batcher.push('b');
    const abandoned = batcher.dispose();

    expect(abandoned).toEqual(['a', 'b']);
    expect(emit).not.toHaveBeenCalled();
  });

  it('cancels pending timers, so nothing fires after dispose', () => {
    const emit = vi.fn();
    const batcher = createCompletionBatcher<string>({ config: TEST_CONFIG, emit });

    batcher.push('a');
    batcher.dispose();
    vi.advanceTimersByTime(TEST_CONFIG.maxWaitMs);

    expect(emit).not.toHaveBeenCalled();
  });
});

describe('createCompletionBatcher disabled mode', () => {
  const disabledConfig = resolveCompletionBatchConfig({ enabled: false });

  it('emits every pushed item immediately and alone', () => {
    const emit = vi.fn();
    const batcher = createCompletionBatcher<string>({ config: disabledConfig, emit });

    batcher.push('a');
    batcher.push('b');

    expect(emit).toHaveBeenNthCalledWith(1, ['a']);
    expect(emit).toHaveBeenNthCalledWith(2, ['b']);
  });

  it('flush and dispose are safe no-ops', () => {
    const emit = vi.fn();
    const batcher = createCompletionBatcher<string>({ config: disabledConfig, emit });

    expect(() => batcher.flush()).not.toThrow();
    expect(batcher.dispose()).toEqual([]);
  });
});

describe('createCompletionBatcher timer lifecycle', () => {
  it('unrefs its timers, so a pending batch cannot keep the process alive', () => {
    const emit = vi.fn();
    const unrefCalls: Array<ReturnType<typeof vi.fn>> = [];
    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((...args: Parameters<typeof setTimeout>) => {
      const timer = originalSetTimeout(...args);
      unrefCalls.push(vi.spyOn(timer, 'unref'));
      return timer;
    }) as typeof setTimeout);

    const batcher = createCompletionBatcher<string>({ config: TEST_CONFIG, emit });
    batcher.push('a');

    // One for the debounce timer, one for the max-wait timer.
    expect(unrefCalls).toHaveLength(2);
    for (const unref of unrefCalls) expect(unref).toHaveBeenCalled();
  });
});

describe('resolveCompletionBatchConfig', () => {
  it('falls back to the documented defaults when nothing is overridden', () => {
    expect(resolveCompletionBatchConfig()).toEqual({
      enabled: true,
      debounceMs: 150,
      maxWaitMs: 1000,
      stragglerDebounceMs: 75,
      stragglerMaxWaitMs: 400,
      stragglerWindowMs: 2000,
    });
  });

  it('ignores an invalid override (zero, negative, non-integer, non-finite) and falls back to the default', () => {
    const resolved = resolveCompletionBatchConfig({ debounceMs: 0, maxWaitMs: -5, stragglerDebounceMs: 1.5 });

    expect(resolved.debounceMs).toBe(150);
    expect(resolved.maxWaitMs).toBe(1000);
    expect(resolved.stragglerDebounceMs).toBe(75);
  });

  it('applies a valid override', () => {
    const resolved = resolveCompletionBatchConfig({ debounceMs: 42, enabled: false });

    expect(resolved.debounceMs).toBe(42);
    expect(resolved.enabled).toBe(false);
  });
});
