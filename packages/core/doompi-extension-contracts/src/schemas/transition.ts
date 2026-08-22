import type { Context } from '@deepseek-ai/cordis';
import {
  DOOM_MINOR_MODE_CATALOG_SERVICE,
  type MinorModeActionRequest,
  type MinorModeCatalogService,
  type MinorModeCatalogSnapshot,
} from './mode.ts';

export type TransitionAxis = 'domains' | 'major-mode' | 'minor-mode' | 'profile';

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
  readonly minorModes?: MinorModeCatalogSnapshot;
}

export interface DomainTransitionTarget {
  readonly axis: 'domains';
  readonly domains: readonly string[];
}

export interface MajorModeTransitionTarget {
  readonly axis: 'major-mode';
  readonly majorMode: string;
}

export interface MinorModeTransitionTarget {
  readonly axis: 'minor-mode';
  readonly action: MinorModeActionRequest;
  readonly requesterSource: string;
}

export interface ProfileTransitionTarget {
  readonly axis: 'profile';
  readonly profile: string;
}

export type TransitionTarget =
  | DomainTransitionTarget
  | MajorModeTransitionTarget
  | MinorModeTransitionTarget
  | ProfileTransitionTarget;

export interface DoomTransitionRequest {
  readonly sessionId: string;
  readonly hostGeneration: string;
  readonly operationId: string;
  readonly source: TransitionSource;
  readonly target: TransitionTarget;
  readonly signal?: AbortSignal;
}

export type TransitionSynchronization =
  | { readonly kind: 'launcher' }
  | {
      readonly kind: 'synchronized';
      readonly resolutionAvailable: boolean;
      readonly availableCompositionFingerprints: readonly string[];
    };

export type TransitionDiagnosticCode =
  | 'transition.live.minor-mode'
  | 'transition.no-change'
  | 'transition.reload.domains'
  | 'transition.reload.major-mode'
  | 'transition.reload.profile'
  | 'transition.rejected.aborted'
  | 'transition.rejected.duplicate'
  | 'transition.rejected.execution'
  | 'transition.rejected.unavailable'
  | 'transition.relaunch.extension-closure'
  | 'transition.stale.generation'
  | 'transition.stale.config'
  | 'transition.stale.session'
  | 'transition.sync-required.artifact'
  | 'transition.sync-required.resolution';

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

export type StructuralTransitionExecution = (
  request: DoomTransitionRequest,
  plan: DoomTransitionPlan,
) => Promise<TransitionOutcome>;

/** Cordis service name the DoomPi host publishes its transition coordinator under. */
export const DOOM_TRANSITION_SERVICE = 'doom/transition';
/** Cordis service name the DoomPi host publishes its minor-mode catalog under. */
export const MINOR_MODE_CATALOG_SERVICE = DOOM_MINOR_MODE_CATALOG_SERVICE;

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
  execute(
    request: DoomTransitionRequest,
    executeStructural?: StructuralTransitionExecution,
  ): Promise<DoomTransitionResult>;
  attachMinorModeCatalog(catalog: MinorModeCatalogHost): () => void;
  dispose(): void;
}

/** The session-scoped minor-mode registry the coordinator routes actions through. */
export type MinorModeCatalogHost = MinorModeCatalogService;

/**
 * Typed reads of the two host services off the session's cordis registry.
 *
 * Optional reads use Cordis's public `ctx.get()` surface. Hard consumers should
 * declare the corresponding service name with `ctx.inject()` before reading it.
 */
export function readDoomTransitionCoordinator(root: Context): DoomTransitionCoordinator | undefined {
  return root.get(DOOM_TRANSITION_SERVICE) as DoomTransitionCoordinator | undefined;
}

export function readMinorModeCatalogHost(root: Context): MinorModeCatalogHost | undefined {
  return root.get(MINOR_MODE_CATALOG_SERVICE) as MinorModeCatalogHost | undefined;
}

/**
 * The coordinator for an injected Cordis context.
 */
export function requireDoomTransitionCoordinator(context: Context): DoomTransitionCoordinator {
  const coordinator = readDoomTransitionCoordinator(context);
  if (!coordinator) throw new Error('Doom transition coordinator is unavailable. Load the DoomPi parent runtime.');
  return coordinator;
}
