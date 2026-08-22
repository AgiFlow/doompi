import { filterHookDisabledLayers, type MajorModesConfig, resolveLayers } from '@agimon-ai/doompi-config/majorModes';
import type {
  DoomTransitionPlan,
  DoomTransitionRequest,
  TransitionDiagnosticCode,
  TransitionDisposition,
  TransitionExecutionStrategy,
  TransitionSelectionSnapshot,
  TransitionSynchronization,
} from '@agimon-ai/doompi-extension-contracts/transition';

export interface TransitionCompositionResolution {
  readonly fingerprint: string;
  readonly parentActivation: readonly string[];
  readonly childActivation: readonly string[];
}

export interface TransitionClassifierContext {
  readonly current: TransitionSelectionSnapshot;
  readonly majorModesConfig: MajorModesConfig;
  readonly hooksEnabled: boolean;
  readonly synchronization: TransitionSynchronization;
  readonly resolveComposition?: (selection: TransitionSelectionSnapshot) => TransitionCompositionResolution | undefined;
}

export function extensionLayers(config: MajorModesConfig, names: readonly string[]): string[] {
  return names.filter((name) => {
    const layer = config.layers[name];
    return Boolean(layer && ((layer.extensions?.length ?? 0) > 0 || (layer.packages?.length ?? 0) > 0));
  });
}

export function needsRelaunch(config: MajorModesConfig, before: readonly string[], after: readonly string[]): boolean {
  const previous = extensionLayers(config, before);
  const candidate = extensionLayers(config, after);
  return previous.length !== candidate.length || previous.some((name, index) => name !== candidate[index]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function copySnapshot(snapshot: TransitionSelectionSnapshot): TransitionSelectionSnapshot {
  return {
    ...snapshot,
    domains: [...snapshot.domains],
    layers: [...snapshot.layers],
    ...(snapshot.parentActivation ? { parentActivation: [...snapshot.parentActivation] } : {}),
    ...(snapshot.childActivation ? { childActivation: [...snapshot.childActivation] } : {}),
    ...(snapshot.minorModes ? { minorModes: structuredClone(snapshot.minorModes) } : {}),
  };
}

function plan(
  request: DoomTransitionRequest,
  disposition: TransitionDisposition,
  previous: TransitionSelectionSnapshot,
  candidate: TransitionSelectionSnapshot,
  diagnostic: TransitionDiagnosticCode,
  strategy?: TransitionExecutionStrategy,
): DoomTransitionPlan {
  return {
    operationId: request.operationId,
    axis: request.target.axis,
    disposition,
    ...(strategy ? { strategy } : {}),
    previous,
    candidate,
    diagnostics: [diagnostic],
    reloadHandoffRequired: disposition === 'reload' || disposition === 'relaunch',
    externalRelaunchRequired: disposition === 'relaunch',
  };
}

function withComposition(
  candidate: TransitionSelectionSnapshot,
  context: TransitionClassifierContext,
): TransitionSelectionSnapshot {
  const composition = context.resolveComposition?.(candidate);
  if (!composition) return candidate;
  return {
    ...candidate,
    compositionFingerprint: composition.fingerprint,
    parentActivation: [...composition.parentActivation],
    childActivation: [...composition.childActivation],
  };
}

function launcherNeedsRelaunch(
  config: MajorModesConfig,
  previous: TransitionSelectionSnapshot,
  candidate: TransitionSelectionSnapshot,
): boolean {
  if (previous.parentActivation && candidate.parentActivation) {
    return !sameStrings(previous.parentActivation, candidate.parentActivation);
  }
  return needsRelaunch(config, previous.layers, candidate.layers);
}

function majorModeDisposition(
  config: MajorModesConfig,
  previous: TransitionSelectionSnapshot,
  candidate: TransitionSelectionSnapshot,
  synchronization: TransitionSynchronization,
): {
  disposition: TransitionDisposition;
  diagnostic: TransitionDiagnosticCode;
  strategy?: TransitionExecutionStrategy;
} {
  if (synchronization.kind === 'synchronized') {
    if (!synchronization.resolutionAvailable || !candidate.compositionFingerprint) {
      return {
        disposition: 'sync-required',
        diagnostic: 'transition.sync-required.resolution',
      };
    }
    if (!synchronization.availableCompositionFingerprints.includes(candidate.compositionFingerprint)) {
      return {
        disposition: 'sync-required',
        diagnostic: 'transition.sync-required.artifact',
      };
    }
    return {
      disposition: 'reload',
      diagnostic: 'transition.reload.major-mode',
      strategy: 'pi-reload',
    };
  }
  return launcherNeedsRelaunch(config, previous, candidate)
    ? {
        disposition: 'relaunch',
        diagnostic: 'transition.relaunch.extension-closure',
        strategy: 'process-relaunch',
      }
    : { disposition: 'reload', diagnostic: 'transition.reload.major-mode', strategy: 'pi-reload' };
}

export function classifyTransition(
  request: DoomTransitionRequest,
  context: TransitionClassifierContext,
): DoomTransitionPlan {
  const previous = copySnapshot(context.current);

  switch (request.target.axis) {
    case 'minor-mode':
      return plan(request, 'live', previous, copySnapshot(previous), 'transition.live.minor-mode');
    case 'domains': {
      const candidate = { ...copySnapshot(previous), domains: [...request.target.domains] };
      if (sameStrings(previous.domains, candidate.domains)) {
        return plan(request, 'live', previous, candidate, 'transition.no-change');
      }
      return plan(request, 'reload', previous, candidate, 'transition.reload.domains', 'pi-reload');
    }
    case 'profile': {
      const candidate = { ...copySnapshot(previous), profile: request.target.profile };
      if (previous.profile === candidate.profile) {
        return plan(request, 'live', previous, candidate, 'transition.no-change');
      }
      return plan(request, 'reload', previous, candidate, 'transition.reload.profile', 'pi-reload');
    }
    case 'major-mode': {
      const candidateLayers = filterHookDisabledLayers(
        context.majorModesConfig,
        resolveLayers(context.majorModesConfig, request.target.majorMode),
        context.hooksEnabled,
      );
      const candidate = withComposition(
        {
          ...copySnapshot(previous),
          majorMode: request.target.majorMode,
          layers: candidateLayers,
          compositionFingerprint: undefined,
          parentActivation: undefined,
          childActivation: undefined,
        },
        context,
      );
      if (
        (previous.majorMode === candidate.majorMode && sameStrings(previous.layers, candidate.layers)) ||
        (previous.compositionFingerprint !== undefined &&
          previous.compositionFingerprint === candidate.compositionFingerprint)
      ) {
        return plan(request, 'live', previous, candidate, 'transition.no-change');
      }
      const classification = majorModeDisposition(
        context.majorModesConfig,
        previous,
        candidate,
        context.synchronization,
      );
      return plan(
        request,
        classification.disposition,
        previous,
        candidate,
        classification.diagnostic,
        classification.strategy,
      );
    }
  }
}
