import type { Context } from '@deepseek-ai/cordis';
export type TransitionAxis = 'domains' | 'major-mode' | 'live' | 'profile';
export type TransitionDisposition = 'live' | 'reload' | 'relaunch' | 'sync-required';
export type TransitionExecutionStrategy = 'pi-reload' | 'process-relaunch';
export type TransitionOutcome = 'applied' | 'queued' | 'unchanged' | 'rejected' | 'stale';
export type TransitionSource = 'voice' | 'command' | 'leader' | 'ui' | 'system';
/** Runtime identities captured when a transition enters the serialized queue. */
export interface TransitionGeneration {
    readonly sessionId: string;
    readonly hostGeneration: string;
    readonly configGeneration?: string;
}
export interface TransitionSelectionSnapshot {
    readonly domains: readonly string[];
    readonly majorMode: string;
    readonly layers: readonly string[];
    readonly profile?: string;
    readonly compositionFingerprint?: string;
    readonly parentActivation?: readonly string[];
    readonly childActivation?: readonly string[];
}
export interface DomainTransitionTarget {
    readonly axis: 'domains';
    readonly domains: readonly string[];
}
export interface MajorModeTransitionTarget {
    readonly axis: 'major-mode';
    readonly majorMode: string;
}
export interface LiveTransitionTarget {
    readonly axis: 'live';
    readonly capability: string;
}
export interface ProfileTransitionTarget {
    readonly axis: 'profile';
    readonly profile: string;
}
export type TransitionTarget = DomainTransitionTarget | MajorModeTransitionTarget | LiveTransitionTarget | ProfileTransitionTarget;
export interface DoomTransitionRequest {
    readonly sessionId: string;
    readonly hostGeneration: string;
    readonly operationId: string;
    readonly source: TransitionSource;
    readonly target: TransitionTarget;
    readonly signal?: AbortSignal;
}
export type TransitionSynchronization = {
    readonly kind: 'launcher';
}
/**
 * A launcher session whose Pi entry resolves its composition on every load.
 *
 * Pi freezes the CLI extension list at construction, so a session handed a
 * fingerprint-named bundle cannot change composition without a new process.
 * One entry that reads the selection when its factory runs lifts that limit:
 * the list Pi holds never changes, and a reload composes again. Such a
 * session is never `sync-required`, because the entry falls back to the
 * individual extension paths when no aggregate has been built yet.
 */
 | {
    readonly kind: 'launcher-composed';
} | {
    readonly kind: 'synchronized';
    readonly resolutionAvailable: boolean;
    readonly availableCompositionFingerprints: readonly string[];
};
export type TransitionDiagnosticCode = 'transition.live.capability' | 'transition.no-change' | 'transition.reload.domains' | 'transition.reload.major-mode' | 'transition.reload.profile' | 'transition.rejected.aborted' | 'transition.rejected.duplicate' | 'transition.rejected.execution' | 'transition.rejected.unavailable' | 'transition.relaunch.extension-closure' | 'transition.stale.generation' | 'transition.stale.config' | 'transition.stale.session' | 'transition.sync-required.artifact' | 'transition.sync-required.resolution';
export interface DoomTransitionPlan {
    readonly operationId: string;
    readonly axis: TransitionAxis;
    readonly disposition: TransitionDisposition;
    readonly strategy?: TransitionExecutionStrategy;
    readonly previous: TransitionSelectionSnapshot;
    readonly candidate: TransitionSelectionSnapshot;
    readonly diagnostics: readonly TransitionDiagnosticCode[];
    readonly reloadHandoffRequired: boolean;
    readonly externalRelaunchRequired: boolean;
}
export interface DoomTransitionResult extends DoomTransitionPlan {
    readonly outcome: TransitionOutcome;
}
export type StructuralTransitionExecution = (request: DoomTransitionRequest, plan: DoomTransitionPlan) => Promise<TransitionOutcome>;
/** Cordis service name the DoomPi host publishes its transition coordinator under. */
export declare const DOOM_TRANSITION_SERVICE = "doom/transition";
/**
 * The session-scoped object that serializes structural transitions.
 *
 * Declared here rather than beside its implementation because the packages that
 * drive the selection axes resolve it from the session and must not depend on
 * the host that builds it. plan() is deliberately synchronous and the result
 * carries live values, so this contract is an in-process handle, not a wire
 * protocol.
 */
export interface DoomTransitionCoordinator {
    readonly sessionId: string;
    readonly hostGeneration: string;
    plan(request: DoomTransitionRequest): DoomTransitionPlan;
    execute(request: DoomTransitionRequest, executeStructural?: StructuralTransitionExecution): Promise<DoomTransitionResult>;
    dispose(): void;
}
/**
 * Typed reads of the two host services off the session's cordis registry.
 *
 * Optional reads use Cordis's public `ctx.get()` surface. Hard consumers should
 * declare the corresponding service name with `ctx.inject()` before reading it.
 */
export declare function readDoomTransitionCoordinator(root: Context): DoomTransitionCoordinator | undefined;
/**
 * The coordinator for an injected Cordis context.
 */
export declare function requireDoomTransitionCoordinator(context: Context): DoomTransitionCoordinator;
//# sourceMappingURL=transition.d.ts.map