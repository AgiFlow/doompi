import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createResourceCatalogSignal } from '../../src/controllers/domainRuntime';

interface Harness {
  readonly pi: ExtensionAPI;
  release(): void;
  readonly appended: Array<{ customType: string; data: unknown }>;
  discover(reason: string): { skillPaths: string[] };
}

function piHarness(): Harness {
  const appended: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
  const signal = createResourceCatalogSignal(pi, 50);
  return {
    release: () => signal.onStop(),
    pi,
    appended,
    discover(reason: string) {
      return signal.events.resources_discover!({ reason } as never, {} as never) as { skillPaths: string[] };
    },
  };
}

describe('resource catalog signal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('journals the rebuilt catalog after a reload so an rpc client re-reads its commands', () => {
    const harness = piHarness();

    harness.discover('reload');
    // Pi applies the returned paths only after every handler resolves, so the
    // entry must not be journalled while the handler is still running.
    expect(harness.appended).toEqual([]);

    vi.advanceTimersByTime(50);

    expect(harness.appended).toHaveLength(1);
    expect(harness.appended[0]?.customType).toBe('doom-resource-catalog');
    expect(harness.appended[0]?.data).toMatchObject({ version: 1 });
  });

  it('stays silent on startup, where a client already reads the catalog on attach', () => {
    const harness = piHarness();

    harness.discover('startup');
    vi.advanceTimersByTime(50);

    expect(harness.appended).toEqual([]);
  });

  it('answers every discovery with the selected skill directories', () => {
    const harness = piHarness();

    expect(harness.discover('startup')).toEqual({ skillPaths: expect.any(Array) });
    expect(harness.discover('reload')).toEqual({ skillPaths: expect.any(Array) });
  });

  it('collapses repeated reloads into one signal', () => {
    const harness = piHarness();

    harness.discover('reload');
    vi.advanceTimersByTime(20);
    harness.discover('reload');
    vi.advanceTimersByTime(50);

    expect(harness.appended).toHaveLength(1);
  });

  it('drops a pending signal when the plugin is released', () => {
    const harness = piHarness();
    const release = () => harness.release();

    harness.discover('reload');
    release();
    vi.advanceTimersByTime(50);

    expect(harness.appended).toEqual([]);
  });
});
