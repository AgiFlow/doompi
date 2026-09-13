import type { DoomTransitionPlan, DoomTransitionRequest, TransitionSelectionSnapshot, TransitionSynchronization } from '../../exports/transition';
export interface TransitionCompositionResolution {
    readonly fingerprint: string;
    readonly parentActivation: readonly string[];
    readonly childActivation: readonly string[];
}
export interface TransitionClassifierContext {
    readonly current: TransitionSelectionSnapshot;
    readonly resolveLayers: (majorMode: string) => readonly string[];
    readonly extensionLayers: (layers: readonly string[]) => readonly string[];
    readonly synchronization: TransitionSynchronization;
    readonly resolveComposition?: (selection: TransitionSelectionSnapshot) => TransitionCompositionResolution | undefined;
}
export declare function classifyTransition(request: DoomTransitionRequest, context: TransitionClassifierContext): DoomTransitionPlan;
//# sourceMappingURL=index.d.ts.map