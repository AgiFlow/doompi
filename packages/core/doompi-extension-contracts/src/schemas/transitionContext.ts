import type { Context } from '@deepseek-ai/cordis';
import type { MinorModeCatalogSnapshot } from './mode.ts';
import { readDoomTransitionCoordinator, readMinorModeCatalogHost } from './transition.ts';

const MINOR_MODE_RELOAD_HANDOFF_SYMBOL = Symbol.for('@agimon-ai/doompi.minor-mode-reload-handoff.v1');
const MINOR_MODE_RELOAD_HANDOFF_TTL_MS = 60_000;

interface StoredMinorModeReloadHandoff {
  readonly token: string;
  readonly sessionId: string;
  readonly transitionHostGeneration: string;
  readonly operationId: string;
  readonly catalogHostGeneration: string;
  readonly snapshot: MinorModeCatalogSnapshot;
  readonly expiresAt: number;
}

interface MinorModeReloadHandoffRegistry {
  readonly records: Map<string, StoredMinorModeReloadHandoff>;
}

export interface MinorModeReloadHandoffHandle {
  discard(): boolean;
}

interface MinorModeReloadHandoffGlobal {
  [MINOR_MODE_RELOAD_HANDOFF_SYMBOL]?: MinorModeReloadHandoffRegistry;
}

function reloadHandoffRegistry(): MinorModeReloadHandoffRegistry {
  const globalRegistry = globalThis as MinorModeReloadHandoffGlobal;
  const existing = globalRegistry[MINOR_MODE_RELOAD_HANDOFF_SYMBOL];
  if (existing) return existing;
  const created: MinorModeReloadHandoffRegistry = { records: new Map() };
  globalRegistry[MINOR_MODE_RELOAD_HANDOFF_SYMBOL] = created;
  return created;
}

function pruneExpiredReloadHandoffs(now = Date.now()): void {
  for (const [sessionId, handoff] of reloadHandoffRegistry().records) {
    if (handoff.expiresAt <= now) reloadHandoffRegistry().records.delete(sessionId);
  }
}

export function prepareMinorModeReloadHandoff(
  context: Context,
  sessionId: string,
  transitionHostGeneration: string,
  operationId: string,
  snapshot: MinorModeCatalogSnapshot | undefined,
): MinorModeReloadHandoffHandle | undefined {
  if (!snapshot?.modes.some(({ state }) => state.activation === 'active' || state.activation === 'activating')) {
    return undefined;
  }
  const coordinator = readDoomTransitionCoordinator(context);
  const catalog = readMinorModeCatalogHost(context);
  if (
    !coordinator ||
    coordinator.hostGeneration !== transitionHostGeneration ||
    !catalog ||
    catalog.generation !== snapshot.hostGeneration
  ) {
    throw new Error('Minor-mode reload handoff became stale before reload.');
  }

  pruneExpiredReloadHandoffs();
  const token = `minor-mode-reload:${crypto.randomUUID()}`;
  const record: StoredMinorModeReloadHandoff = {
    token,
    sessionId,
    transitionHostGeneration,
    operationId,
    catalogHostGeneration: snapshot.hostGeneration,
    snapshot: structuredClone(snapshot),
    expiresAt: Date.now() + MINOR_MODE_RELOAD_HANDOFF_TTL_MS,
  };
  reloadHandoffRegistry().records.set(sessionId, record);

  return {
    discard() {
      const current = reloadHandoffRegistry().records.get(sessionId);
      if (current?.token !== token) return false;
      return reloadHandoffRegistry().records.delete(sessionId);
    },
  };
}

export function discardMinorModeReloadHandoff(sessionId: string): boolean {
  pruneExpiredReloadHandoffs();
  return reloadHandoffRegistry().records.delete(sessionId);
}

export function consumeMinorModeReloadHandoff(sessionId: string): MinorModeCatalogSnapshot | undefined {
  pruneExpiredReloadHandoffs();
  const handoff = reloadHandoffRegistry().records.get(sessionId);
  if (!handoff) return undefined;
  reloadHandoffRegistry().records.delete(sessionId);
  if (
    handoff.sessionId !== sessionId ||
    handoff.snapshot.hostGeneration !== handoff.catalogHostGeneration ||
    !handoff.transitionHostGeneration ||
    !handoff.operationId
  ) {
    return undefined;
  }
  return structuredClone(handoff.snapshot);
}
