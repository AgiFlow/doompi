import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import type { MinorModeActionRequest } from '@agimon-ai/doompi-extension-contracts/mode';
import { describe, expect, it, vi } from 'vitest';
import type { MinorModeCatalogHost } from '@agimon-ai/doompi-extension-contracts/transition';
import {
  createDoomTransitionCoordinator,
  type TransitionCoordinatorOptions,
} from '../../src/services/transitionCoordinator.ts';
import type { DoomTransitionRequest, TransitionTarget } from '@agimon-ai/doompi-extension-contracts/transition';

const fingerprints = { copilot: 'a'.repeat(64), team: 'b'.repeat(64) } as const;

const config: MajorModesConfig = {
  layers: {
    task: { baseDirectory: '/repo', packages: ['@agimon-ai/doompi-task'] },
    team: { baseDirectory: '/repo', packages: ['@agimon-ai/doompi-team'] },
  },
  defaultMajorMode: 'copilot',
  majorMode: {
    copilot: { description: 'Copilot.', layers: ['task'] },
    team: { description: 'Team.', layers: ['task', 'team'] },
  },
};

function createCoordinator(overrides: Partial<TransitionCoordinatorOptions> = {}) {
  return createDoomTransitionCoordinator({
    sessionId: 'session-1',
    hostGeneration: 'generation-1',
    classifierContext: () => ({
      current: {
        domains: ['engineering'],
        majorMode: 'copilot',
        layers: ['task'],
        profile: 'default',
      },
      majorModesConfig: config,
      hooksEnabled: true,
      synchronization: { kind: 'launcher' },
    }),
    ...overrides,
  });
}

function request(target: TransitionTarget, operationId = 'operation-1'): DoomTransitionRequest {
  return {
    sessionId: 'session-1',
    hostGeneration: 'generation-1',
    operationId,
    source: 'command',
    target,
  };
}

function minorAction(operationId = 'minor-operation-1'): MinorModeActionRequest {
  return {
    operationId,
    mode: {
      source: '@agimon-ai/doompi-plan',
      id: 'plan',
      ownerGeneration: 'owner-1',
      registrationId: 'registration-1',
    },
    actionId: 'activate',
    arguments: {},
  };
}

function catalog(invoke = vi.fn().mockResolvedValue({})): MinorModeCatalogHost {
  return {
    generation: 'catalog-1',
    getSnapshot: () => ({ hostGeneration: 'catalog-1', revision: 0, modes: [] }),
    list: () => [],
    subscribe: () => () => undefined,
    registerOwner: vi.fn(() => ({ getState: vi.fn(), publish: vi.fn(), dispose: vi.fn() })),
    invoke,
    dispose: vi.fn(),
  };
}

describe('Doom transition coordinator', () => {
  it('plans with the attached live minor-mode snapshot', () => {
    const coordinator = createCoordinator();
    coordinator.attachMinorModeCatalog(catalog());

    const transitionPlan = coordinator.plan(
      request({ axis: 'minor-mode', action: minorAction(), requesterSource: '@agimon-ai/requester' }),
    );

    expect(transitionPlan.candidate.minorModes).toMatchObject({ hostGeneration: 'catalog-1' });
  });

  it('reports unchanged and queued outcomes without inventing execution primitives', async () => {
    const coordinator = createCoordinator();

    await expect(
      coordinator.execute(request({ axis: 'domains', domains: ['engineering'] }, 'unchanged')),
    ).resolves.toMatchObject({ outcome: 'unchanged', disposition: 'live' });
    await expect(
      coordinator.execute(request({ axis: 'domains', domains: ['marketing'] }, 'queued')),
    ).resolves.toMatchObject({ outcome: 'queued', disposition: 'reload' });
  });

  it('plans subsequent reloads from the last committed selection', async () => {
    const coordinator = createCoordinator({
      classifierContext: () => ({
        current: {
          domains: ['engineering'],
          majorMode: 'copilot',
          layers: ['task'],
          compositionFingerprint: fingerprints.copilot,
        },
        majorModesConfig: config,
        hooksEnabled: true,
        synchronization: {
          kind: 'synchronized',
          resolutionAvailable: true,
          availableCompositionFingerprints: Object.values(fingerprints),
        },
        resolveComposition: (selection) => ({
          fingerprint: fingerprints[selection.majorMode as keyof typeof fingerprints],
          parentActivation: selection.layers.map((layer) => `/extensions/${layer}.mjs`),
          childActivation: selection.layers.map((layer) => `/child/${layer}.mjs`),
        }),
      }),
    });
    const first = request({ axis: 'major-mode', majorMode: 'team' });

    await expect(coordinator.execute(first, async () => 'applied')).resolves.toMatchObject({
      outcome: 'applied',
      strategy: 'pi-reload',
    });

    expect(coordinator.plan(request({ axis: 'major-mode', majorMode: 'team' }, 'repeat'))).toMatchObject({
      diagnostics: ['transition.no-change'],
      previous: { majorMode: 'team', layers: ['task', 'team'] },
    });
  });

  it('keeps planning from the active selection while a reload-bound switch is only queued', async () => {
    const coordinator = createCoordinator();

    await expect(
      coordinator.execute(request({ axis: 'domains', domains: ['marketing'] }), async () => 'queued'),
    ).resolves.toMatchObject({ outcome: 'queued' });

    expect(coordinator.plan(request({ axis: 'domains', domains: ['marketing'] }, 'retry'))).toMatchObject({
      previous: { domains: ['engineering'] },
      candidate: { domains: ['marketing'] },
    });
  });

  it('delegates live minor-mode actions to the existing catalog', async () => {
    const invoke = vi.fn().mockResolvedValue({});
    const coordinator = createCoordinator();
    coordinator.attachMinorModeCatalog(catalog(invoke));
    const action = minorAction();

    const outcome = await coordinator.execute(
      request({ axis: 'minor-mode', action, requesterSource: '@agimon-ai/requester' }),
    );

    expect(outcome.outcome).toBe('applied');
    expect(invoke).toHaveBeenCalledWith(action, '@agimon-ai/requester', undefined);
  });

  it('routes minor-mode protocol callbacks without replacing catalog replay ownership', async () => {
    const invoke = vi.fn().mockResolvedValue({});
    const execution = vi.fn(async () => 'applied' as const);
    const coordinator = createCoordinator();
    coordinator.attachMinorModeCatalog(catalog(invoke));
    const transition = request({
      axis: 'minor-mode',
      action: minorAction(),
      requesterSource: '@agimon-ai/doompi-voice',
    });

    await expect(coordinator.execute(transition, execution)).resolves.toMatchObject({ outcome: 'applied' });
    await expect(coordinator.execute(transition, execution)).resolves.toMatchObject({ outcome: 'applied' });
    expect(execution).toHaveBeenCalledTimes(2);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects a minor-mode request when no catalog is attached', async () => {
    const coordinator = createCoordinator();

    await expect(
      coordinator.execute(
        request({ axis: 'minor-mode', action: minorAction(), requesterSource: '@agimon-ai/requester' }),
      ),
    ).resolves.toMatchObject({
      outcome: 'rejected',
      diagnostics: expect.arrayContaining(['transition.rejected.unavailable']),
    });
  });

  it('serializes structural transitions while leaving their executor authoritative', async () => {
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const executeStructural = vi.fn(async (transition: DoomTransitionRequest) => {
      started.push(transition.operationId);
      await new Promise<void>((resolve) => releases.push(resolve));
      return 'applied' as const;
    });
    const coordinator = createCoordinator({ executeStructural });

    const first = coordinator.execute(request({ axis: 'domains', domains: ['marketing'] }, 'first'));
    const second = coordinator.execute(request({ axis: 'profile', profile: 'focused' }, 'second'));
    await vi.waitFor(() => expect(started).toEqual(['first']));
    releases.shift()?.();
    await expect(first).resolves.toMatchObject({ outcome: 'applied' });
    await vi.waitFor(() => expect(started).toEqual(['first', 'second']));
    releases.shift()?.();
    await expect(second).resolves.toMatchObject({ outcome: 'applied' });
  });

  it('replans a queued structural request after the preceding operation completes', async () => {
    let current = {
      domains: ['engineering'],
      majorMode: 'copilot',
      layers: ['task'],
      profile: 'default',
    };
    let releaseFirst: (() => void) | undefined;
    const started: string[] = [];
    const executeStructural = vi.fn(async (transition: DoomTransitionRequest) => {
      started.push(transition.operationId);
      if (transition.operationId === 'first') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return transition.operationId === 'first' ? ('queued' as const) : ('applied' as const);
    });
    const coordinator = createCoordinator({
      executeStructural,
      classifierContext: () => ({
        current,
        majorModesConfig: config,
        hooksEnabled: true,
        synchronization: { kind: 'launcher' },
      }),
    });

    const first = coordinator.execute(request({ axis: 'domains', domains: ['marketing'] }, 'first'));
    const second = coordinator.execute(request({ axis: 'major-mode', majorMode: 'team' }, 'second'));
    await vi.waitFor(() => expect(started).toEqual(['first']));
    current = { ...current, majorMode: 'team', layers: ['task', 'team'] };
    releaseFirst?.();

    await expect(first).resolves.toMatchObject({ outcome: 'queued' });
    await expect(second).resolves.toMatchObject({ outcome: 'unchanged' });
    expect(executeStructural).toHaveBeenCalledTimes(1);
  });

  it('rejects a queued request when its config generation changes', async () => {
    let releaseFirst: (() => void) | undefined;
    let generation = {
      sessionId: 'session-1',
      hostGeneration: 'generation-1',
      kernelGeneration: 'kernel-1',
      configGeneration: 'config-1',
    };
    const executeStructural = vi.fn(async (transition: DoomTransitionRequest) => {
      if (transition.operationId === 'first') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return 'queued' as const;
      }
      return 'applied' as const;
    });
    const coordinator = createCoordinator({ executeStructural, generation: () => generation });
    const first = coordinator.execute(request({ axis: 'domains', domains: ['marketing'] }, 'first'));
    const second = coordinator.execute(request({ axis: 'profile', profile: 'focused' }, 'second'));
    await vi.waitFor(() => expect(executeStructural).toHaveBeenCalledOnce());
    generation = { ...generation, kernelGeneration: 'kernel-2', configGeneration: 'config-2' };
    releaseFirst?.();

    await expect(first).resolves.toMatchObject({ outcome: 'stale' });
    await expect(second).resolves.toMatchObject({
      outcome: 'stale',
      diagnostics: expect.arrayContaining(['transition.stale.config']),
    });
    expect(executeStructural).toHaveBeenCalledOnce();
  });

  it('uses a request-scoped executor and propagates execution failures to the handoff owner', async () => {
    const fallback = vi.fn(async () => 'queued' as const);
    const coordinator = createCoordinator({ executeStructural: fallback });
    const execution = vi.fn(async () => 'applied' as const);

    await expect(
      coordinator.execute(request({ axis: 'domains', domains: ['marketing'] }), execution),
    ).resolves.toMatchObject({ outcome: 'applied' });
    expect(fallback).not.toHaveBeenCalled();

    await expect(
      coordinator.execute(request({ axis: 'profile', profile: 'focused' }, 'failing'), async () =>
        Promise.reject(new Error('handoff failed')),
      ),
    ).rejects.toThrow('handoff failed');
  });

  it('aborts queued structural transitions on dispose', async () => {
    let release: (() => void) | undefined;
    const executeStructural = vi.fn(
      () =>
        new Promise<'applied'>((resolve) => {
          release = () => resolve('applied');
        }),
    );
    const coordinator = createCoordinator({ executeStructural });
    const first = coordinator.execute(request({ axis: 'domains', domains: ['marketing'] }, 'first'));
    const queued = coordinator.execute(request({ axis: 'profile', profile: 'focused' }, 'queued'));
    await vi.waitFor(() => expect(executeStructural).toHaveBeenCalledOnce());

    coordinator.dispose();
    release?.();

    await expect(first).resolves.toMatchObject({ outcome: 'applied' });
    await expect(queued).resolves.toMatchObject({
      outcome: 'rejected',
      diagnostics: expect.arrayContaining(['transition.rejected.aborted']),
    });
  });

  it('rejects duplicate operation ids', async () => {
    const coordinator = createCoordinator();
    const transition = request({ axis: 'domains', domains: ['marketing'] });
    await coordinator.execute(transition);

    await expect(coordinator.execute(transition)).resolves.toMatchObject({
      outcome: 'rejected',
      diagnostics: expect.arrayContaining(['transition.rejected.duplicate']),
    });
  });

  it.each([
    {
      name: 'session',
      mutate: (transition: DoomTransitionRequest) => ({ ...transition, sessionId: 'session-2' }),
      diagnostic: 'transition.stale.session',
    },
    {
      name: 'generation',
      mutate: (transition: DoomTransitionRequest) => ({ ...transition, hostGeneration: 'generation-2' }),
      diagnostic: 'transition.stale.generation',
    },
  ])('fences a stale $name before execution', async ({ mutate, diagnostic }) => {
    const executeStructural = vi.fn(async () => 'applied' as const);
    const coordinator = createCoordinator({ executeStructural });
    const transition = mutate(request({ axis: 'domains', domains: ['marketing'] }));

    await expect(coordinator.execute(transition)).resolves.toMatchObject({
      outcome: 'stale',
      diagnostics: expect.arrayContaining([diagnostic]),
    });
    expect(executeStructural).not.toHaveBeenCalled();
  });

  it('reports sync-required plans as rejected without executing them', async () => {
    const executeStructural = vi.fn(async () => 'applied' as const);
    const coordinator = createCoordinator({
      executeStructural,
      classifierContext: () => ({
        current: { domains: [], majorMode: 'copilot', layers: ['task'] },
        majorModesConfig: config,
        hooksEnabled: true,
        synchronization: {
          kind: 'synchronized',
          resolutionAvailable: false,
          availableCompositionFingerprints: [],
        },
      }),
    });

    await expect(coordinator.execute(request({ axis: 'major-mode', majorMode: 'team' }))).resolves.toMatchObject({
      outcome: 'rejected',
      disposition: 'sync-required',
    });
    expect(executeStructural).not.toHaveBeenCalled();
  });

  it('rejects an already-aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    const coordinator = createCoordinator();

    await expect(
      coordinator.execute({
        ...request({ axis: 'domains', domains: ['marketing'] }),
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      outcome: 'rejected',
      diagnostics: expect.arrayContaining(['transition.rejected.aborted']),
    });
  });
});
