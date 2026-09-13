import type { DoomToolRestriction } from '@agimon-ai/doompi-core/tool-surface';

import { AUTHOR_FACADE_TOOL_NAMES } from '../../constants/author';
import { OPEN_AUTHORING_FILE_TOOL_NAME, type AuthorViewportCatalogSnapshot } from '../../types/author';
import type { AuthorCatalog } from './type';

const CATALOG_POLL_MS = 500;

export interface AuthorModeMonitorClock {
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface AuthorCatalogMonitor {
  snapshot(): AuthorViewportCatalogSnapshot | undefined;
  subscribe(listener: () => void): () => void;
  start(): void;
  stop(): void;
  dispose(): void;
}

/** Hide Author tools until the mode and viewport catalog can serve them. */
export function authorToolRestriction(active: boolean, catalogReady: boolean): DoomToolRestriction {
  const hidden = new Set<string>([
    ...(active ? [] : [OPEN_AUTHORING_FILE_TOOL_NAME]),
    ...(active && catalogReady ? [] : AUTHOR_FACADE_TOOL_NAMES),
  ]);
  return (incoming) => (hidden.size === 0 ? incoming : incoming.filter((name) => !hidden.has(name)));
}

/** Author-specific viewport polling; the shared minor-mode factory owns activation. */
export function createAuthorCatalogMonitor(
  catalog: AuthorCatalog,
  clock: AuthorModeMonitorClock,
): AuthorCatalogMonitor {
  let current: AuthorViewportCatalogSnapshot | undefined;
  let active = false;
  let disposed = false;
  let generation = 0;
  let cancelTimer: (() => void) | undefined;
  let request: AbortController | undefined;
  const listeners = new Set<() => void>();
  const setCatalog = (snapshot: AuthorViewportCatalogSnapshot | undefined): void => {
    const previous = current;
    current = snapshot;
    if (
      previous?.catalogToken !== snapshot?.catalogToken ||
      previous?.tools.length !== snapshot?.tools.length ||
      (previous === undefined) !== (snapshot === undefined)
    )
      listeners.forEach((listener) => listener());
  };
  const poll = (owner: number): void => {
    if (!active || owner !== generation || disposed) return;
    const controller = new AbortController();
    request = controller;
    void catalog
      .describe(controller.signal)
      .then((snapshot) => {
        if (active && owner === generation && snapshot.catalogToken !== '') setCatalog(snapshot);
      })
      .catch(() => {
        if (active && owner === generation) setCatalog(undefined);
      })
      .finally(() => {
        if (request === controller) request = undefined;
        if (!active || owner !== generation || disposed) return;
        cancelTimer = clock.schedule(() => poll(owner), CATALOG_POLL_MS);
      });
  };
  const stop = (): void => {
    active = false;
    generation += 1;
    cancelTimer?.();
    cancelTimer = undefined;
    request?.abort();
    request = undefined;
    setCatalog(undefined);
  };
  return {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (active || disposed) return;
      active = true;
      generation += 1;
      poll(generation);
    },
    stop,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      listeners.clear();
    },
  };
}
