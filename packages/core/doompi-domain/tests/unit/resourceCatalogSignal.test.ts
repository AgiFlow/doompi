import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerResourceCatalogSignal } from '../../src/adapters/pi/extension.ts';

type ResourcesHandler = (event: { reason: string }) => { skillPaths: string[] };

interface Harness {
  readonly pi: ExtensionAPI;
  readonly appended: Array<{ customType: string; data: unknown }>;
  discover(reason: string): { skillPaths: string[] };
}

function piHarness(): Harness {
  let handler: ResourcesHandler | undefined;
  const appended: Array<{ customType: string; data: unknown }> = [];
  const pi = {
    on(event: string, registered: ResourcesHandler) {
      if (event === 'resources_discover') handler = registered;
    },
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
    },
  } as unknown as ExtensionAPI;
  return {
    pi,
    appended,
    discover(reason: string) {
      if (!handler) throw new Error('The resources_discover handler was never registered.');
      return handler({ reason });
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
    registerResourceCatalogSignal(harness.pi, 50);

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
    registerResourceCatalogSignal(harness.pi, 50);

    harness.discover('startup');
    vi.advanceTimersByTime(50);

    expect(harness.appended).toEqual([]);
  });

  it('answers every discovery with the selected skill directories', () => {
    const harness = piHarness();
    registerResourceCatalogSignal(harness.pi, 50);

    expect(harness.discover('startup')).toEqual({ skillPaths: expect.any(Array) });
    expect(harness.discover('reload')).toEqual({ skillPaths: expect.any(Array) });
  });

  it('collapses repeated reloads into one signal', () => {
    const harness = piHarness();
    registerResourceCatalogSignal(harness.pi, 50);

    harness.discover('reload');
    vi.advanceTimersByTime(20);
    harness.discover('reload');
    vi.advanceTimersByTime(50);

    expect(harness.appended).toHaveLength(1);
  });

  it('drops a pending signal when the plugin is released', () => {
    const harness = piHarness();
    const release = registerResourceCatalogSignal(harness.pi, 50);

    harness.discover('reload');
    release();
    vi.advanceTimersByTime(50);

    expect(harness.appended).toEqual([]);
  });
});
