import { Context } from '@deepseek-ai/cordis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MinorModeCatalogSnapshot } from '../src/exports/mode.ts';
import type { DoomTransitionCoordinator, MinorModeCatalogHost } from '../src/exports/transition.ts';
import {
  consumeMinorModeReloadHandoff,
  DOOM_TRANSITION_SERVICE,
  MINOR_MODE_CATALOG_SERVICE,
  prepareMinorModeReloadHandoff,
  requireDoomTransitionCoordinator,
} from '../src/exports/transition.ts';

const cleanup: Array<() => void> = [];

/**
 * Opens an isolated Cordis application root for a test session.
 */
function openSession(sessionId = `session-${crypto.randomUUID()}`) {
  const root = new Context();
  cleanup.push(() => {
    void root.fiber.dispose();
  });
  return { root, sessionId };
}

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

function coordinator(generation: string): DoomTransitionCoordinator {
  return {
    sessionId: 'session-1',
    hostGeneration: generation,
    plan: vi.fn(),
    execute: vi.fn(),
    attachMinorModeCatalog: vi.fn(() => vi.fn()),
    dispose: vi.fn(),
  } as unknown as DoomTransitionCoordinator;
}

function catalogSnapshot(hostGeneration: string): MinorModeCatalogSnapshot {
  return {
    hostGeneration,
    revision: 1,
    modes: [
      {
        descriptor: {
          source: '@agimon-ai/test-mode',
          id: 'test',
          label: 'Test',
          description: 'Test mode.',
          order: 1,
          actions: [],
        },
        state: { activation: 'active', condition: 'ready', actions: [] },
        ownerGeneration: 'owner-1',
        registrationId: 'registration-1',
        stateRevision: 1,
      },
    ],
  };
}

function catalog(generation: string): MinorModeCatalogHost {
  return {
    generation,
    getSnapshot: vi.fn(),
    invoke: vi.fn(),
    dispose: vi.fn(),
  } as unknown as MinorModeCatalogHost;
}

describe('transition context', () => {
  it('keeps one session registry isolated from another', () => {
    const first = openSession();
    const second = openSession();
    first.root.provide(DOOM_TRANSITION_SERVICE, coordinator('first'));
    second.root.provide(DOOM_TRANSITION_SERVICE, coordinator('second'));

    expect(requireDoomTransitionCoordinator(first.root).hostGeneration).toBe('first');
    expect(requireDoomTransitionCoordinator(second.root).hostGeneration).toBe('second');
  });

  it('does not let one provider disposer unpublish another root', () => {
    const first = new Context();
    const second = new Context();
    const releaseFirst = first.provide(DOOM_TRANSITION_SERVICE, coordinator('first'));
    second.provide(DOOM_TRANSITION_SERVICE, coordinator('second'));

    releaseFirst();

    expect(first.get(DOOM_TRANSITION_SERVICE)).toBeUndefined();
    expect(second.get(DOOM_TRANSITION_SERVICE)?.hostGeneration).toBe('second');
    void Promise.all([first.fiber.dispose(), second.fiber.dispose()]);
  });

  it('fails closed when no provider has published the transition service', () => {
    const root = new Context();
    expect(() => requireDoomTransitionCoordinator(root)).toThrow('Doom transition coordinator is unavailable');
    void root.fiber.dispose();
  });

  it('unregisters a service with the fiber that provided it', () => {
    const { root } = openSession();
    const release = root.provide(MINOR_MODE_CATALOG_SERVICE, catalog('first'));

    expect(root.get(MINOR_MODE_CATALOG_SERVICE)?.generation).toBe('first');
    release();
    expect(root.get(MINOR_MODE_CATALOG_SERVICE)).toBeUndefined();
  });

  it('transports a reload snapshot once and protects replacement handoffs', () => {
    const { root, sessionId } = openSession(`reload-${crypto.randomUUID()}`);
    const snapshot = catalogSnapshot('catalog-1');
    root.provide(DOOM_TRANSITION_SERVICE, coordinator('transition-1'));
    root.provide(MINOR_MODE_CATALOG_SERVICE, catalog('catalog-1'));
    const first = prepareMinorModeReloadHandoff(root, sessionId, 'transition-1', 'operation-1', snapshot);
    const second = prepareMinorModeReloadHandoff(root, sessionId, 'transition-1', 'operation-2', snapshot);
    if (!first || !second) throw new Error('reload handoff was not prepared');

    snapshot.modes[0]!.state.activation = 'inactive';
    expect(first.discard()).toBe(false);
    expect(consumeMinorModeReloadHandoff(sessionId)).toMatchObject({
      hostGeneration: 'catalog-1',
      modes: [{ state: { activation: 'active' } }],
    });
    expect(consumeMinorModeReloadHandoff(sessionId)).toBeUndefined();
    expect(second.discard()).toBe(false);
    const inactiveSnapshot = catalogSnapshot('catalog-1');
    inactiveSnapshot.modes[0]!.state.activation = 'inactive';
    expect(
      prepareMinorModeReloadHandoff(root, sessionId, 'transition-1', 'operation-inactive', inactiveSnapshot),
    ).toBeUndefined();
  });

  it('rejects a catalog generation change and supports explicit cleanup', () => {
    const { root, sessionId } = openSession(`stale-${crypto.randomUUID()}`);
    root.provide(DOOM_TRANSITION_SERVICE, coordinator('transition-1'));
    root.provide(MINOR_MODE_CATALOG_SERVICE, catalog('catalog-2'));

    expect(() =>
      prepareMinorModeReloadHandoff(root, sessionId, 'transition-1', 'operation-1', catalogSnapshot('catalog-1')),
    ).toThrow('became stale');
    const handoff = prepareMinorModeReloadHandoff(
      root,
      sessionId,
      'transition-1',
      'operation-2',
      catalogSnapshot('catalog-2'),
    );
    expect(handoff?.discard()).toBe(true);
    expect(consumeMinorModeReloadHandoff(sessionId)).toBeUndefined();
    expect(() =>
      prepareMinorModeReloadHandoff(root, sessionId, 'transition-stale', 'operation-3', catalogSnapshot('catalog-2')),
    ).toThrow('became stale');
  });
});
