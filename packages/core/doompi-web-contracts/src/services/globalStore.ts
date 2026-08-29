import { Store } from '@tanstack/store';
import type { GlobalStore } from '../types/webPlugin.ts';

/** Page-wide plugin state shared by every contribution from the plugin. */
export function defineGlobalStore<T>(initial: T): GlobalStore<T> {
  const store = new Store<T>(initial);

  const update = (updater: (current: T) => T): void => {
    const current = store.state;
    const next = updater(current);
    if (next !== current) store.setState(() => next);
  };

  const reset = (): void => {
    store.setState((current) => (current === initial ? current : initial));
  };

  return { store, update, reset };
}
