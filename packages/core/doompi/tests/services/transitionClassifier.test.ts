import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import type { MinorModeActionRequest } from '@agimon-ai/doompi-extension-contracts/mode';
import { describe, expect, it } from 'vitest';
import { classifyTransition, type TransitionClassifierContext } from '../../src/services/transitionClassifier.ts';
import type {
  DoomTransitionRequest,
  TransitionSelectionSnapshot,
  TransitionSynchronization,
  TransitionTarget,
} from '@agimon-ai/doompi-extension-contracts/transition';

const config: MajorModesConfig = {
  layers: {
    scaffolding: { baseDirectory: '/repo', hookGroups: ['scaffolding'] },
    task: { baseDirectory: '/repo', packages: ['@agimon-ai/doompi-task'] },
    team: { baseDirectory: '/repo', packages: ['@agimon-ai/doompi-team'] },
  },
  defaultMajorMode: 'copilot',
  majorMode: {
    copilot: { description: 'Copilot.', layers: ['scaffolding', 'task'] },
    review: { description: 'Review.', layers: ['task'] },
    team: { description: 'Team.', layers: ['task', 'team'] },
  },
};

const fingerprints = {
  copilot: 'a'.repeat(64),
  review: 'b'.repeat(64),
  team: 'c'.repeat(64),
} as const;

const current: TransitionSelectionSnapshot = {
  domains: ['engineering'],
  majorMode: 'copilot',
  layers: ['scaffolding', 'task'],
  profile: 'default',
  compositionFingerprint: fingerprints.copilot,
};

function request(target: TransitionTarget): DoomTransitionRequest {
  return {
    sessionId: 'session-1',
    hostGeneration: 'generation-1',
    operationId: 'operation-1',
    source: 'command',
    target,
  };
}

function context(synchronization: TransitionSynchronization = { kind: 'launcher' }): TransitionClassifierContext {
  return {
    current,
    majorModesConfig: config,
    hooksEnabled: true,
    synchronization,
    resolveComposition: (selection) => ({
      fingerprint: fingerprints[selection.majorMode as keyof typeof fingerprints],
      parentActivation: selection.layers.map((layer) => `/extensions/${layer}.mjs`),
      childActivation: selection.layers.map((layer) => `/child/${layer}.mjs`),
    }),
  };
}

function minorAction(): MinorModeActionRequest {
  return {
    operationId: 'minor-operation-1',
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

describe('transition classifier', () => {
  it('classifies catalog-owned minor-mode actions as live', () => {
    const result = classifyTransition(
      request({ axis: 'minor-mode', action: minorAction(), requesterSource: '@agimon-ai/requester' }),
      context(),
    );

    expect(result).toMatchObject({
      axis: 'minor-mode',
      disposition: 'live',
      diagnostics: ['transition.live.minor-mode'],
      reloadHandoffRequired: false,
      externalRelaunchRequired: false,
    });
  });

  it.each([
    { target: { axis: 'domains', domains: ['engineering'] } as const },
    { target: { axis: 'profile', profile: 'default' } as const },
    { target: { axis: 'major-mode', majorMode: 'copilot' } as const },
  ])('classifies an unchanged $target.axis selection as a live no-op', ({ target }) => {
    const result = classifyTransition(request(target), context());

    expect(result.disposition).toBe('live');
    expect(result.diagnostics).toEqual(['transition.no-change']);
  });

  it('classifies changed domains and profiles as reload-bound', () => {
    const domains = classifyTransition(request({ axis: 'domains', domains: ['marketing'] }), context());
    const profile = classifyTransition(request({ axis: 'profile', profile: 'focused' }), context());

    expect(domains).toMatchObject({
      disposition: 'reload',
      strategy: 'pi-reload',
      candidate: { domains: ['marketing'] },
      diagnostics: ['transition.reload.domains'],
      reloadHandoffRequired: true,
    });
    expect(profile).toMatchObject({
      disposition: 'reload',
      strategy: 'pi-reload',
      candidate: { profile: 'focused' },
      diagnostics: ['transition.reload.profile'],
      reloadHandoffRequired: true,
    });
  });

  it('uses extension closure changes as the launcher relaunch authority', () => {
    const reload = classifyTransition(request({ axis: 'major-mode', majorMode: 'review' }), context());
    const relaunch = classifyTransition(request({ axis: 'major-mode', majorMode: 'team' }), context());

    expect(reload).toMatchObject({
      disposition: 'reload',
      diagnostics: ['transition.reload.major-mode'],
      externalRelaunchRequired: false,
    });
    expect(relaunch).toMatchObject({
      disposition: 'relaunch',
      strategy: 'process-relaunch',
      diagnostics: ['transition.relaunch.extension-closure'],
      externalRelaunchRequired: true,
    });
  });

  it('reloads a changed extension closure when the launcher session composes on load', () => {
    // The same switch that forces a relaunch on a frozen launcher session.
    const relaunch = classifyTransition(request({ axis: 'major-mode', majorMode: 'team' }), context());
    const composed = classifyTransition(
      request({ axis: 'major-mode', majorMode: 'team' }),
      context({ kind: 'launcher-composed' }),
    );

    expect(relaunch.disposition).toBe('relaunch');
    expect(composed).toMatchObject({
      disposition: 'reload',
      strategy: 'pi-reload',
      diagnostics: ['transition.reload.major-mode'],
      externalRelaunchRequired: false,
    });
  });

  it('never reports sync-required for a composing launcher session', () => {
    // It can always fall back to the individual entries, so an unbuilt
    // aggregate is not a reason to refuse the switch.
    const result = classifyTransition(
      request({ axis: 'major-mode', majorMode: 'team' }),
      context({ kind: 'launcher-composed' }),
    );

    expect(result.disposition).not.toBe('sync-required');
  });

  it('treats structural Task layer changes as launcher relaunches', () => {
    const withoutTask: TransitionClassifierContext = {
      ...context(),
      current: { ...current, majorMode: 'empty', layers: [] },
    };

    const result = classifyTransition(request({ axis: 'major-mode', majorMode: 'review' }), withoutTask);

    expect(result.disposition).toBe('relaunch');
  });

  it('allows synchronized composition to reload a changed extension closure', () => {
    const result = classifyTransition(
      request({ axis: 'major-mode', majorMode: 'team' }),
      context({
        kind: 'synchronized',
        resolutionAvailable: true,
        availableCompositionFingerprints: Object.values(fingerprints),
      }),
    );

    expect(result).toMatchObject({
      disposition: 'reload',
      diagnostics: ['transition.reload.major-mode'],
      externalRelaunchRequired: false,
    });
    expect(result.candidate.childActivation).toEqual(['/child/task.mjs', '/child/team.mjs']);
  });

  it.each([
    {
      synchronization: {
        kind: 'synchronized',
        resolutionAvailable: false,
        availableCompositionFingerprints: Object.values(fingerprints),
      } as const,
      diagnostic: 'transition.sync-required.resolution',
      resolveComposition: undefined,
    },
    {
      synchronization: {
        kind: 'synchronized',
        resolutionAvailable: true,
        availableCompositionFingerprints: [fingerprints.copilot],
      } as const,
      diagnostic: 'transition.sync-required.artifact',
      resolveComposition: context().resolveComposition,
    },
  ])('reports missing synchronized state as sync-required', ({ synchronization, diagnostic, resolveComposition }) => {
    const result = classifyTransition(request({ axis: 'major-mode', majorMode: 'team' }), {
      ...context(synchronization),
      resolveComposition,
    });

    expect(result).toMatchObject({
      disposition: 'sync-required',
      diagnostics: [diagnostic],
      reloadHandoffRequired: false,
      externalRelaunchRequired: false,
    });
  });

  it('treats equal canonical composition fingerprints as unchanged', () => {
    const result = classifyTransition(request({ axis: 'major-mode', majorMode: 'review' }), {
      ...context(),
      resolveComposition: () => ({
        fingerprint: fingerprints.copilot,
        parentActivation: ['/same.mjs'],
        childActivation: ['/child/same.mjs'],
      }),
    });

    expect(result).toMatchObject({
      disposition: 'live',
      diagnostics: ['transition.no-change'],
      reloadHandoffRequired: false,
    });
  });

  it('does not mutate the caller selection', () => {
    const before = structuredClone(current);

    const result = classifyTransition(request({ axis: 'domains', domains: ['marketing'] }), context());

    expect(current).toEqual(before);
    expect(result.previous).not.toBe(current);
    expect(result.previous.domains).not.toBe(current.domains);
  });
});
