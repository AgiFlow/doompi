import type { ExtensionAPI, ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { Context } from '@deepseek-ai/cordis';
import { DOOM_CONFIG_SERVICE } from '../../types/config.ts';
import type {
  DoomConfigSelection as ConfigSelection,
  DeepReadonly,
  DoomConfigContext,
  DoomConfigPendingSelection,
  DoomConfigTransitionRecord,
  DoomConfigTransitionStrategy,
  HarnessState,
  IDoomConfigService,
} from '../../types/config.ts';
import { loadDoomConfig, loadDoomConfigAsync } from '../config.ts';
import { getHarnessState } from '../harnessStore.ts';
import { DoomConfigService } from '../../providers/doomConfigService.ts';

export const DOOM_CONFIG_ENTRY_TYPE = 'doom-pi:config:v1';
export const DOOM_CONFIG_TRANSITION_ENTRY_TYPE = 'doom-pi:transition:v1';

export type DoomConfigSelection = ConfigSelection;

type DoomConfigTransitionEntry = DoomConfigTransitionRecord;

function isSelection(value: unknown): value is DoomConfigSelection {
  if (typeof value !== 'object' || value === null) return false;
  const selection = value as Partial<DoomConfigSelection>;
  return (
    selection.version === 1 &&
    typeof selection.majorMode === 'string' &&
    Array.isArray(selection.domains) &&
    selection.domains.every((domain) => typeof domain === 'string') &&
    (selection.profile === undefined || typeof selection.profile === 'string') &&
    (selection.compositionFingerprint === undefined || typeof selection.compositionFingerprint === 'string')
  );
}

function branchSelection(entries: readonly SessionEntry[]): DoomConfigSelection | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === 'custom' && entry.customType === DOOM_CONFIG_ENTRY_TYPE && isSelection(entry.data)) {
      return entry.data;
    }
  }
  return undefined;
}

function isTransitionStrategy(value: unknown): value is DoomConfigTransitionStrategy {
  return value === 'pi-reload' || value === 'process-relaunch';
}

function isTransition(value: unknown): value is DoomConfigTransitionEntry {
  if (typeof value !== 'object' || value === null) return false;
  const transition = value as Partial<DoomConfigTransitionEntry>;
  return (
    transition.version === 1 &&
    typeof transition.operationId === 'string' &&
    isSelection(transition.active) &&
    isSelection(transition.target) &&
    isTransitionStrategy(transition.strategy) &&
    (transition.phase === 'pending' ||
      transition.phase === 'applied' ||
      transition.phase === 'aborted' ||
      transition.phase === 'superseded')
  );
}

function branchTransition(entries: readonly SessionEntry[]): DoomConfigTransitionEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type === 'custom' &&
      entry.customType === DOOM_CONFIG_TRANSITION_ENTRY_TYPE &&
      isTransition(entry.data)
    ) {
      return entry.data;
    }
  }
  return undefined;
}

function sameSelection(left: DoomConfigSelection, state: HarnessState): boolean {
  return (
    left.majorMode === state.majorMode &&
    left.profile === state.profile &&
    (left.compositionFingerprint === undefined || left.compositionFingerprint === state.compositionFingerprint) &&
    left.domains.length === state.domains.length &&
    left.domains.every((domain, index) => domain === state.domains[index])
  );
}

function isActiveTransitionTarget(target: DoomConfigSelection, state: HarnessState): boolean {
  return (
    target.compositionFingerprint !== undefined &&
    target.compositionFingerprint === state.compositionFingerprint &&
    sameSelection(target, state)
  );
}

function pendingFromTransition(transition: DoomConfigTransitionEntry): DoomConfigPendingSelection | undefined {
  if (transition.phase !== 'pending') return undefined;
  return { ...transition, phase: 'pending' };
}

function pendingFromLegacySelection(
  selection: DoomConfigSelection,
  bootstrap: HarnessState,
): DoomConfigPendingSelection | undefined {
  if (sameSelection(selection, bootstrap)) return undefined;
  const active: DoomConfigSelection = {
    version: 1,
    majorMode: bootstrap.majorMode,
    domains: [...bootstrap.domains],
    profile: bootstrap.profile,
    compositionFingerprint: bootstrap.compositionFingerprint,
  };
  return {
    version: 1,
    operationId: 'legacy-config-selection',
    active,
    target: selection,
    strategy: 'process-relaunch',
    phase: 'pending',
  };
}

function deepFreeze<TValue>(value: TValue): DeepReadonly<TValue> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<TValue>;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value) as DeepReadonly<TValue>;
}

export function readDoomConfigSelection(
  ctx: Pick<ExtensionContext, 'sessionManager'>,
): DoomConfigSelection | undefined {
  return branchSelection(ctx.sessionManager.getBranch());
}

function resolveContextState(ctx: Pick<ExtensionContext, 'sessionManager'>): {
  harness: HarnessState;
  pendingSelection: DoomConfigPendingSelection | undefined;
  requiresRelaunch: boolean;
  root: string | undefined;
} {
  const bootstrap = getHarnessState();
  const entries = ctx.sessionManager.getBranch();
  const selection = branchSelection(entries);
  const transition = branchTransition(entries);
  const transitionPending = transition ? pendingFromTransition(transition) : undefined;
  const pendingSelection = transition
    ? transitionPending
    : selection
      ? pendingFromLegacySelection(selection, bootstrap)
      : undefined;
  return {
    harness: bootstrap,
    pendingSelection,
    requiresRelaunch:
      pendingSelection !== undefined &&
      (transitionPending === undefined || !isActiveTransitionTarget(pendingSelection.target, bootstrap)),
    root: bootstrap.root,
  };
}

export function createDoomConfigContext(ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>): DoomConfigContext {
  const { harness, pendingSelection, requiresRelaunch, root } = resolveContextState(ctx);
  return deepFreeze({ settings: loadDoomConfig(root ?? ctx.cwd), harness, pendingSelection, requiresRelaunch });
}

export async function createDoomConfigContextAsync(
  ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>,
): Promise<DoomConfigContext> {
  const { harness, pendingSelection, requiresRelaunch, root } = resolveContextState(ctx);
  const settings = await loadDoomConfigAsync(root ?? ctx.cwd);
  return deepFreeze({ settings, harness, pendingSelection, requiresRelaunch });
}

export function appendDoomConfigSelection(pi: Pick<ExtensionAPI, 'appendEntry'>, selection: DoomConfigSelection): void {
  pi.appendEntry(DOOM_CONFIG_ENTRY_TYPE, selection);
}

/** Journals the live selection, defaulting to whatever the harness store holds. */
export function persistHarnessSelection(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  state: {
    readonly majorMode: string;
    readonly domains: readonly string[];
    readonly profile?: string;
    readonly compositionFingerprint?: string;
  } = getHarnessState(),
): void {
  appendDoomConfigSelection(pi, {
    version: 1,
    majorMode: state.majorMode,
    domains: state.domains,
    profile: state.profile,
    compositionFingerprint: state.compositionFingerprint,
  });
}

export function appendDoomConfigTransition(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  transition: DoomConfigTransitionRecord,
): void {
  pi.appendEntry(DOOM_CONFIG_TRANSITION_ENTRY_TYPE, transition);
}

export function supersedeDoomConfigTransition(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  transition: DoomConfigPendingSelection,
): void {
  pi.appendEntry(DOOM_CONFIG_TRANSITION_ENTRY_TYPE, { ...transition, phase: 'superseded' });
}

/** Acknowledges the latest pending transition from a fresh session that owns its exact target composition. */
export function acknowledgeDoomConfigTransition(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  ctx: Pick<ExtensionContext, 'sessionManager'>,
  harness: HarnessState,
): boolean {
  const transition = branchTransition(ctx.sessionManager.getBranch());
  if (!transition || transition.phase !== 'pending' || !isActiveTransitionTarget(transition.target, harness)) {
    return false;
  }
  appendDoomConfigTransition(pi, { ...transition, phase: 'applied' });
  return true;
}

export function readDoomConfigPendingSelection(
  ctx: Pick<ExtensionContext, 'sessionManager'>,
): DoomConfigPendingSelection | undefined {
  const bootstrap = getHarnessState();
  const transition = branchTransition(ctx.sessionManager.getBranch());
  const transitionPending = transition ? pendingFromTransition(transition) : undefined;
  if (transition) return transitionPending;
  const selection = branchSelection(ctx.sessionManager.getBranch());
  return selection ? pendingFromLegacySelection(selection, bootstrap) : undefined;
}

export function provideDoomConfigContext(
  ctx: Context,
  context: DoomConfigContext,
  generation = `doom-config:${crypto.randomUUID()}`,
): IDoomConfigService {
  return new DoomConfigService(ctx, deepFreeze(context) as DoomConfigContext, loadDoomConfig, generation);
}

/** Returns the binding identity used to fence in-flight transitions. */
export function readDoomConfigContextGeneration(ctx: Context): string | undefined {
  return readDoomConfigService(ctx)?.generation;
}

/** Precomputes an immutable context before a transaction reaches publication. */
export function freezeDoomConfigContext(context: DoomConfigContext): DoomConfigContext {
  return deepFreeze(context);
}

/** Replaces a live binding with a deeply frozen context after publication. */
export function replaceDoomConfigContext(ctx: Context, context: DoomConfigContext): DoomConfigContext {
  const next = deepFreeze(context);
  return requireDoomConfigService(ctx).replaceSnapshot(next as DoomConfigContext);
}

export function readDoomConfigService(ctx: Context): IDoomConfigService | undefined {
  return ctx.get(DOOM_CONFIG_SERVICE) as IDoomConfigService | undefined;
}

export function requireDoomConfigService(ctx: Context): IDoomConfigService {
  const service = readDoomConfigService(ctx);
  if (!service) throw new Error('Doom config service is unavailable. Load @agimon-ai/doompi-config/extensions/pi.');
  return service;
}

export function requireDoomConfigContext(ctx: Context): DoomConfigContext {
  return requireDoomConfigService(ctx).getSnapshot();
}
