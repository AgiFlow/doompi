import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { provideDoomConfigContext } from '@agimon-ai/doompi-config/piContext';
import { connectDoomCordisHost } from '@agimon-ai/doompi-extension-contracts/cordis-host';
import type { DoomConfigContext } from '@agimon-ai/doompi-config/types';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import cordisHostExtension from '../../src/extensions/entries/cordisHost.ts';
import transitionCoordinatorExtension, {
  currentTransitionSynchronization,
} from '../../src/extensions/entries/transitionCoordinator.ts';
import type { MinorModeCatalogHost } from '@agimon-ai/doompi-extension-contracts/transition';
import {
  MINOR_MODE_CATALOG_SERVICE,
  requireDoomTransitionCoordinator,
} from '@agimon-ai/doompi-extension-contracts/transition';

const { createMapResolvers, loadMajorModesConfig, readSyncState } = vi.hoisted(() => ({
  createMapResolvers: vi.fn(),
  loadMajorModesConfig: vi.fn(),
  readSyncState: vi.fn(),
}));

vi.mock('@agimon-ai/doompi-config/majorModes', () => ({ loadMajorModesConfig }));
vi.mock('../../src/adapters/syncState.ts', () => ({ createMapResolvers, readSyncState }));

beforeEach(() => {
  vi.clearAllMocks();
  readSyncState.mockReset();
  createMapResolvers.mockReturnValue({
    optionalPackageEntry: vi.fn(),
    ownEntry: vi.fn(() => '/persona.mjs'),
  });
  loadMajorModesConfig.mockReturnValue({
    layers: {},
    defaultMajorMode: 'copilot',
    majorMode: {
      copilot: { description: 'Copilot', layers: [] },
      review: { description: 'Review', layers: [] },
      stale: { description: 'Stale', layers: [] },
    },
  });
});

async function setup() {
  const lifecycle = new Map<string, Array<(event: unknown, context: ExtensionContext) => unknown>>();
  const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
  const pi = {
    events: {
      emit(name: string, value: unknown) {
        for (const handler of eventHandlers.get(name) ?? []) handler(value);
      },
      on(name: string, handler: (value: unknown) => void) {
        const handlers = eventHandlers.get(name) ?? new Set();
        handlers.add(handler);
        eventHandlers.set(name, handlers);
        return () => handlers.delete(handler);
      },
    },
    on: vi.fn((name: string, handler: (event: unknown, context: ExtensionContext) => void) => {
      lifecycle.set(name, [...(lifecycle.get(name) ?? []), handler]);
    }),
  } as unknown as ExtensionAPI;
  await cordisHostExtension(pi);
  await transitionCoordinatorExtension(pi);
  const sessionManager = { getSessionId: () => 'session-1' };
  const context = {
    cwd: process.cwd(),
    sessionManager,
  } as unknown as ExtensionContext;
  const config = {
    settings: {},
    harness: {
      root: process.cwd(),
      majorMode: 'copilot',
      domains: ['engineering'],
      layers: ['task'],
      profile: 'default',
      profileEnvironment: {},
      skillDirectories: [],
      agentDirectories: [],
      additionalDirectories: [],
      childExtensions: [],
      pluginDirectories: [],
      pluginHooks: [],
      allowProtectedWrites: false,
      hooks: true,
      agents: true,
      mcp: true,
    },
    requiresRelaunch: false,
  } as unknown as DoomConfigContext;
  const connection = await connectDoomCordisHost(pi, 'transition-coordinator-test');
  provideDoomConfigContext(connection.root, config);
  return {
    cordis: connection.root,
    context,
    async dispatch(name: string, event: unknown = {}) {
      for (const handler of lifecycle.get(name) ?? []) await handler(event, context);
    },
    async dispose() {
      await connection.dispose();
    },
  };
}

function catalog(): MinorModeCatalogHost {
  return {
    generation: 'catalog-1',
    getSnapshot: () => ({ hostGeneration: 'catalog-1', revision: 0, modes: [] }),
    list: () => [],
    subscribe: () => () => undefined,
    registerOwner: vi.fn(() => ({ getState: vi.fn(), publish: vi.fn(), dispose: vi.fn() })),
    invoke: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('transition synchronization', () => {
  it('distinguishes launcher, missing resolution, and missing artifacts', () => {
    expect(currentTransitionSynchronization('/repo', {})).toEqual({ kind: 'launcher' });

    readSyncState.mockReturnValueOnce(undefined);
    expect(currentTransitionSynchronization('/repo', { DOOMPI_COMPOSED: '1' })).toEqual({
      kind: 'synchronized',
      resolutionAvailable: false,
      availableCompositionFingerprints: [],
    });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transition-sync-'));
    const existing = path.join(root, 'entry.mjs');
    fs.writeFileSync(existing, 'export default undefined;\n');
    readSyncState.mockReturnValueOnce({
      resolved: { entry: existing },
      compiled: {},
      bundles: {},
      selection: { majorMode: 'copilot' },
    });
    expect(currentTransitionSynchronization(root, { DOOMPI_COMPOSED: '1' })).toEqual({
      kind: 'synchronized',
      resolutionAvailable: true,
      availableCompositionFingerprints: [],
    });
    readSyncState.mockReturnValueOnce({
      resolved: { entry: `${existing}.missing` },
      compiled: {},
      bundles: { ['a'.repeat(64)]: existing },
      selection: { majorMode: 'copilot' },
    });
    expect(currentTransitionSynchronization(root, { DOOMPI_COMPOSED: '1' })).toEqual({
      kind: 'synchronized',
      resolutionAvailable: false,
      availableCompositionFingerprints: ['a'.repeat(64)],
    });
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('transition coordinator extension', () => {
  it('binds one parent session coordinator and attaches the existing catalog', async () => {
    const runtime = await setup();
    // The catalog entry runs first in activation and opens the session registry,
    // so the coordinator entry finds an existing catalog to attach to.
    const catalogFiber = runtime.cordis.plugin((cordis) => {
      cordis.provide(MINOR_MODE_CATALOG_SERVICE, catalog());
    });
    await catalogFiber;

    await runtime.dispatch('session_start', { reason: 'startup' });
    const coordinator = requireDoomTransitionCoordinator(runtime.cordis);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const transitionPlan = coordinator.plan({
      sessionId: coordinator.sessionId,
      hostGeneration: coordinator.hostGeneration,
      operationId: 'operation-1',
      source: 'system',
      target: {
        axis: 'minor-mode',
        requesterSource: '@agimon-ai/test',
        action: {
          operationId: 'minor-operation-1',
          mode: {
            source: '@agimon-ai/doompi-plan',
            id: 'plan',
            ownerGeneration: 'owner-1',
            registrationId: 'registration-1',
          },
          actionId: 'activate',
          arguments: {},
        },
      },
    });

    expect(coordinator.sessionId).toBe('session-1');
    expect(transitionPlan.candidate.minorModes).toMatchObject({ hostGeneration: 'catalog-1' });

    await runtime.dispatch('session_shutdown');
    expect(() => requireDoomTransitionCoordinator(runtime.cordis)).toThrow('unavailable');
    await catalogFiber.dispose();
    await runtime.dispose();
  });
});
