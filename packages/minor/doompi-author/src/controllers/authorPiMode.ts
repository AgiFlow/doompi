import type { PiToolRestriction } from '@agimon-ai/doompi-core/pi-extension';

import { AUTHOR_PACKAGE_SOURCE } from '../constants/author';
import { authorMinorMode } from '../models/authorMode';
import { authorToolRestriction, createAuthorCatalogMonitor } from '../services/authorCatalog/monitor';
import type { AuthorCatalog } from '../services/authorCatalog/type';

export interface AuthorPiMode {
  readonly mode: ReturnType<typeof authorMinorMode.createOwner>;
  readonly restriction: PiToolRestriction;
  isActive(): boolean;
  assertAvailable(this: void): void;
  onStart(this: void): void;
  onStop(this: void): void;
  onDispose(this: void): void;
}

/** Own Author's viewport polling independently from host registration. */
export function createAuthorPiMode(catalog: AuthorCatalog, signal: AbortSignal): AuthorPiMode {
  const monitor = createAuthorCatalogMonitor(catalog, {
    schedule(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
  });
  let active = false;
  let started = false;
  let unsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = () => {
    mode.publish();
    listeners.forEach((listener) => listener());
  };
  const mode = authorMinorMode.createOwner({
    isActive: () => active,
    detail: () => (monitor.snapshot() ? 'document viewport focused' : 'waiting for a focused document'),
    setActive(enabled) {
      signal.throwIfAborted();
      if (active === enabled) return;
      active = enabled;
      if (active && started) monitor.start();
      else monitor.stop();
      publish();
    },
  });
  const restriction: PiToolRestriction = {
    source: AUTHOR_PACKAGE_SOURCE,
    restrict: (incoming, context) => authorToolRestriction(active, !!monitor.snapshot())(incoming, context),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    mode,
    restriction,
    isActive: () => active,
    assertAvailable() {
      if (signal.aborted) throw new Error('The Author runtime is disposed.');
      if (!active) throw new Error('Author mode is not active.');
    },
    onStart() {
      started = true;
      unsubscribe = monitor.subscribe(publish);
      if (active) monitor.start();
    },
    onStop() {
      started = false;
      active = false;
      unsubscribe?.();
      unsubscribe = undefined;
      monitor.stop();
    },
    onDispose() {
      monitor.dispose();
      listeners.clear();
    },
  };
}
