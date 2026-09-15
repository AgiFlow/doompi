import { Store } from '@tanstack/store';

import type { WorkspaceRecords, WorkspaceStore } from '../types/webPlugin';

/**
 * Per-workspace plugin state with the drop and reset bookkeeping built in.
 *
 * One TanStack store holds a record per workspace id. `empty` is handed back by
 * reference for every workspace that has not reported, which is what keeps a
 * useStore selector stable: the hook compares by identity, so a fresh object
 * per read would re-render forever. Records are therefore immutable values,
 * and updaters return new ones.
 *
 * There is no channel helper here. The hub addresses a channel frame to a
 * session id, so a workspace record is filled by the plugin's own API calls
 * rather than by a pushed frame.
 */
export function defineWorkspaceStore<T>(empty: T): WorkspaceStore<T> {
  const store = new Store<WorkspaceRecords<T>>({});

  const select = (state: WorkspaceRecords<T>, workspaceId: string | null): T =>
    workspaceId === null ? empty : (state[workspaceId] ?? empty);

  const update = (workspaceId: string, updater: (current: T) => T): void => {
    const current = select(store.state, workspaceId);
    const next = updater(current);
    if (next === current) return;
    store.setState((state) => ({ ...state, [workspaceId]: next }));
  };

  const drop = (workspaceId: string): void => {
    store.setState((state) => {
      if (!(workspaceId in state)) return state;
      const rest = { ...state };
      delete rest[workspaceId];
      return rest;
    });
  };

  const reset = (): void => {
    store.setState(() => ({}));
  };

  return { store, select, update, drop, reset };
}
