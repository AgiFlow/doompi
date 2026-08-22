import { Context } from '@deepseek-ai/cordis';
import {
  DOOM_TRANSITION_SERVICE,
  type DoomTransitionCoordinator,
  type DoomTransitionPlan,
  type DoomTransitionRequest,
  type MinorModeCatalogHost,
  type TransitionSelectionSnapshot,
} from '@agimon-ai/doompi-extension-contracts/transition';

/**
 * A coordinator stub on a real cordis registry.
 *
 * The host owns createDoomTransitionCoordinator and this package must not depend
 * on the host, so these tests publish an object satisfying the contract onto a
 * session Context of their own — the same way the host publishes the real one.
 * What they exercise is that the command plans, applies, journals and reloads in
 * the right order, not how the host serializes structural transitions.
 */
export function bindStubCoordinator(
  context: Context,
  sessionId: string,
  current: TransitionSelectionSnapshot,
  outcome: 'applied' | 'rejected' = 'applied',
): { readonly dispose: () => void; readonly plans: DoomTransitionRequest[] } {
  const plans: DoomTransitionRequest[] = [];
  const planFor = (request: DoomTransitionRequest): DoomTransitionPlan => ({
    operationId: request.operationId,
    axis: request.target.axis,
    disposition: 'reload',
    strategy: 'pi-reload',
    previous: current,
    candidate: current,
    diagnostics: ['transition.reload.profile'],
    reloadHandoffRequired: true,
    externalRelaunchRequired: false,
  });

  const coordinator: DoomTransitionCoordinator = {
    sessionId,
    hostGeneration: 'stub-transition-host',
    plan(request) {
      plans.push(request);
      return planFor(request);
    },
    async execute(request, executeStructural) {
      plans.push(request);
      const plan = planFor(request);
      if (outcome !== 'applied') return { ...plan, outcome };
      const applied = await executeStructural?.(request, plan);
      return { ...plan, outcome: applied ?? 'applied' };
    },
    attachMinorModeCatalog(_catalog: MinorModeCatalogHost) {
      return () => undefined;
    },
    dispose() {
      // The stub owns nothing.
    },
  };

  const unpublish = context.provide(DOOM_TRANSITION_SERVICE, coordinator);
  return {
    plans,
    dispose() {
      unpublish();
    },
  };
}
