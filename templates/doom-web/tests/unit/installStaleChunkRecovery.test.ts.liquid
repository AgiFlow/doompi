import { describe, expect, it, vi } from 'vitest';
import { installStaleChunkRecovery } from '../../src/web/lib/installStaleChunkRecovery.ts';

function preloadError(payload: unknown): Event {
  return Object.assign(new Event('vite:preloadError', { cancelable: true }), { payload });
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe('installStaleChunkRecovery', () => {
  it('reloads once for a stale dynamic import and leaves a repeat failure to normal error handling', () => {
    const target = new EventTarget();
    const reload = vi.fn();
    installStaleChunkRecovery({ target, storage: memoryStorage(), reload });

    const first = preloadError(
      new Error('Failed to fetch dynamically imported module: /assets/CodeEditorView-a1b2c3.js'),
    );
    const second = preloadError(
      new Error('Failed to fetch dynamically imported module: /assets/CodeEditorView-a1b2c3.js'),
    );

    target.dispatchEvent(first);
    target.dispatchEvent(second);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(false);
  });

  it('does not intercept unrelated preload errors', () => {
    const target = new EventTarget();
    const reload = vi.fn();
    installStaleChunkRecovery({ target, storage: memoryStorage(), reload });
    const event = preloadError(new Error('The lazy component threw while rendering'));

    target.dispatchEvent(event);

    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('preserves normal error handling when session storage cannot guard the reload', () => {
    const target = new EventTarget();
    const reload = vi.fn();
    const storage = {
      getItem: () => {
        throw new Error('storage unavailable');
      },
      setItem: vi.fn(),
    };
    installStaleChunkRecovery({ target, storage, reload });
    const event = preloadError(new Error('Failed to fetch dynamically imported module: /assets/View-deadbeef.js'));

    target.dispatchEvent(event);

    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});
