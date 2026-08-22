import type {
  DoomTransitionCoordinator,
  DoomTransitionPlan,
  DoomTransitionRequest,
  DoomTransitionResult,
  MinorModeCatalogHost,
  StructuralTransitionExecution,
  TransitionDiagnosticCode,
  TransitionGeneration,
  TransitionOutcome,
} from '@agimon-ai/doompi-extension-contracts/transition';
import { classifyTransition, type TransitionClassifierContext } from './transitionClassifier.ts';

const MINOR_MODE_AXIS = 'minor-mode';
const STALE_SESSION_DIAGNOSTIC: TransitionDiagnosticCode = 'transition.stale.session';
const STALE_GENERATION_DIAGNOSTIC: TransitionDiagnosticCode = 'transition.stale.generation';
const ABORTED_DIAGNOSTIC: TransitionDiagnosticCode = 'transition.rejected.aborted';
const EXECUTION_DIAGNOSTIC: TransitionDiagnosticCode = 'transition.rejected.execution';
const NO_CHANGE_DIAGNOSTIC: TransitionDiagnosticCode = 'transition.no-change';

export interface TransitionCoordinatorOptions {
  readonly sessionId: string;
  readonly hostGeneration?: string;
  readonly classifierContext: () => TransitionClassifierContext;
  /** Captures identities that must remain stable while a transition is queued. */
  readonly generation?: () => TransitionGeneration;
  readonly acceptGenerationChange?: (
    before: TransitionGeneration,
    after: TransitionGeneration,
    plan: DoomTransitionPlan,
  ) => boolean;
  readonly executeStructural?: (request: DoomTransitionRequest, plan: DoomTransitionPlan) => Promise<TransitionOutcome>;
}

function result(
  plan: DoomTransitionPlan,
  outcome: TransitionOutcome,
  diagnostic?: TransitionDiagnosticCode,
): DoomTransitionResult {
  return {
    ...plan,
    outcome,
    diagnostics: diagnostic ? [...plan.diagnostics, diagnostic] : plan.diagnostics,
  };
}

function defaultGeneration(sessionId: string, hostGeneration: string): TransitionGeneration {
  return { sessionId, hostGeneration };
}

function generationDiagnostic(
  expected: TransitionGeneration,
  current: TransitionGeneration,
): TransitionDiagnosticCode | undefined {
  if (expected.sessionId !== current.sessionId) return STALE_SESSION_DIAGNOSTIC;
  if (expected.hostGeneration !== current.hostGeneration) return STALE_GENERATION_DIAGNOSTIC;
  if (expected.configGeneration !== current.configGeneration) return 'transition.stale.config';
  return undefined;
}

export function createDoomTransitionCoordinator(options: TransitionCoordinatorOptions): DoomTransitionCoordinator {
  const hostGeneration = options.hostGeneration ?? `doom-transition:${crypto.randomUUID()}`;
  const readGeneration = options.generation ?? (() => defaultGeneration(options.sessionId, hostGeneration));
  const operationIds = new Set<string>();
  let minorModeCatalog: MinorModeCatalogHost | undefined;
  let committedSelection: DoomTransitionPlan['candidate'] | undefined;
  let structuralTail: Promise<void> = Promise.resolve();
  let structuralPending = 0;
  let disposed = false;

  const plan = (request: DoomTransitionRequest): DoomTransitionPlan => {
    const context = options.classifierContext();
    const current = {
      ...(committedSelection ?? context.current),
      ...(minorModeCatalog ? { minorModes: minorModeCatalog.getSnapshot() } : {}),
    };
    return classifyTransition(request, { ...context, current });
  };

  const requestDiagnostic = (request: DoomTransitionRequest): TransitionDiagnosticCode | undefined => {
    if (request.sessionId !== options.sessionId) return STALE_SESSION_DIAGNOSTIC;
    if (request.hostGeneration !== hostGeneration) return STALE_GENERATION_DIAGNOSTIC;
    if (disposed || request.signal?.aborted) return ABORTED_DIAGNOSTIC;
    if (request.target.axis !== MINOR_MODE_AXIS && operationIds.has(request.operationId)) {
      return 'transition.rejected.duplicate';
    }
    return undefined;
  };

  const executeMinorMode = async (
    request: DoomTransitionRequest,
    transitionPlan: DoomTransitionPlan,
    execution: StructuralTransitionExecution | undefined,
    expectedGeneration: TransitionGeneration,
  ): Promise<DoomTransitionResult> => {
    if (request.target.axis !== MINOR_MODE_AXIS) {
      return result(transitionPlan, 'rejected', EXECUTION_DIAGNOSTIC);
    }
    const catalog = minorModeCatalog;
    if (!catalog) return result(transitionPlan, 'rejected', 'transition.rejected.unavailable');
    const before = generationDiagnostic(expectedGeneration, readGeneration());
    if (before) return result(transitionPlan, 'stale', before);
    try {
      if (execution) {
        const outcome = await execution(request, transitionPlan);
        const currentGeneration = readGeneration();
        const after = generationDiagnostic(expectedGeneration, currentGeneration);
        if (after && !options.acceptGenerationChange?.(expectedGeneration, currentGeneration, transitionPlan)) {
          return result(transitionPlan, 'stale', after);
        }
        return result(transitionPlan, outcome);
      }
      await catalog.invoke(request.target.action, request.target.requesterSource, request.signal);
      const currentGeneration = readGeneration();
      const after = generationDiagnostic(expectedGeneration, currentGeneration);
      return after ? result(transitionPlan, 'stale', after) : result(transitionPlan, 'applied');
    } catch {
      return result(transitionPlan, 'rejected', EXECUTION_DIAGNOSTIC);
    }
  };

  const executeStructural = async (
    request: DoomTransitionRequest,
    transitionPlan: DoomTransitionPlan,
    execution: StructuralTransitionExecution | undefined,
    expectedGeneration: TransitionGeneration,
  ): Promise<DoomTransitionResult> => {
    if (disposed || request.signal?.aborted) {
      return result(transitionPlan, 'rejected', ABORTED_DIAGNOSTIC);
    }
    const stale = generationDiagnostic(expectedGeneration, readGeneration());
    if (stale) return result(transitionPlan, 'stale', stale);
    if (transitionPlan.disposition === 'sync-required') {
      return result(transitionPlan, 'rejected');
    }
    const selectedExecution = execution ?? options.executeStructural;
    if (!selectedExecution) {
      const outcome = transitionPlan.disposition === 'live' ? 'applied' : 'queued';
      if (outcome === 'applied') committedSelection = transitionPlan.candidate;
      return result(transitionPlan, outcome);
    }
    const outcome = await selectedExecution(request, transitionPlan);
    const currentGeneration = readGeneration();
    const after = generationDiagnostic(expectedGeneration, currentGeneration);
    if (after && !options.acceptGenerationChange?.(expectedGeneration, currentGeneration, transitionPlan)) {
      return result(transitionPlan, 'stale', after);
    }
    if (outcome === 'applied') committedSelection = transitionPlan.candidate;
    return result(transitionPlan, outcome);
  };

  return {
    sessionId: options.sessionId,
    hostGeneration,
    plan,
    async execute(request, execution) {
      const admission = requestDiagnostic(request);
      if (admission) {
        const outcome = admission.startsWith('transition.rejected.') ? 'rejected' : 'stale';
        return result(plan(request), outcome, admission);
      }
      const expectedGeneration = readGeneration();
      if (expectedGeneration.sessionId !== options.sessionId) {
        return result(plan(request), 'stale', STALE_SESSION_DIAGNOSTIC);
      }
      if (expectedGeneration.hostGeneration !== hostGeneration) {
        return result(plan(request), 'stale', STALE_GENERATION_DIAGNOSTIC);
      }
      if (request.target.axis !== MINOR_MODE_AXIS) operationIds.add(request.operationId);

      if (request.target.axis === MINOR_MODE_AXIS) {
        const transitionPlan = plan(request);
        if (transitionPlan.diagnostics.includes(NO_CHANGE_DIAGNOSTIC)) return result(transitionPlan, 'unchanged');
        return executeMinorMode(request, transitionPlan, execution, expectedGeneration);
      }

      structuralPending += 1;
      const queued = structuralTail.then(async () => {
        const transitionPlan = plan(request);
        const stale = generationDiagnostic(expectedGeneration, readGeneration());
        if (stale) return result(transitionPlan, 'stale', stale);
        if (transitionPlan.diagnostics.includes(NO_CHANGE_DIAGNOSTIC)) return result(transitionPlan, 'unchanged');
        return executeStructural(request, transitionPlan, execution, expectedGeneration);
      });
      structuralTail = queued.then(
        () => undefined,
        () => undefined,
      );
      try {
        return await queued;
      } finally {
        structuralPending -= 1;
      }
    },
    attachMinorModeCatalog(catalog) {
      minorModeCatalog = catalog;
      return () => {
        if (minorModeCatalog === catalog) minorModeCatalog = undefined;
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      minorModeCatalog = undefined;
      committedSelection = undefined;
      operationIds.clear();
      if (structuralPending === 0) structuralTail = Promise.resolve();
    },
  };
}
