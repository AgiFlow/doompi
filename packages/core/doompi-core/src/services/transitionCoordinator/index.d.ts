import type { DoomTransitionCoordinator, DoomTransitionPlan, DoomTransitionRequest, TransitionGeneration, TransitionOutcome } from '../../exports/transition';
import { type TransitionClassifierContext } from '../transitionClassifier';
export interface TransitionCoordinatorOptions {
    readonly sessionId: string;
    readonly hostGeneration?: string;
    readonly classifierContext: () => TransitionClassifierContext;
    /** Captures identities that must remain stable while a transition is queued. */
    readonly generation?: () => TransitionGeneration;
    readonly acceptGenerationChange?: (before: TransitionGeneration, after: TransitionGeneration, plan: DoomTransitionPlan) => boolean;
    readonly executeStructural?: (request: DoomTransitionRequest, plan: DoomTransitionPlan) => Promise<TransitionOutcome>;
}
export declare function createDoomTransitionCoordinator(options: TransitionCoordinatorOptions): DoomTransitionCoordinator;
//# sourceMappingURL=index.d.ts.map