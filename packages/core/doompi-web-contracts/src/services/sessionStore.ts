import { Store } from '@tanstack/store';
import type {
  SessionChannelContribution,
  SessionRecords,
  SessionStore,
  SessionStoreChannel,
} from '../types/webPlugin.ts';
import { defineSessionChannel } from './define.ts';

/**
 * Per-session plugin state with the drop and reset bookkeeping built in.
 *
 * One TanStack store holds a record per session id. `empty` is handed back by
 * reference for every session that has not reported, which is what keeps a
 * useStore selector stable: the hook compares by identity, so a fresh object
 * per read would re-render forever. Records are therefore immutable values,
 * and updaters and reducers return new ones.
 */
export function defineSessionStore<T>(empty: T): SessionStore<T> {
  const store = new Store<SessionRecords<T>>({});

  const select = (state: SessionRecords<T>, sessionId: string | null): T =>
    sessionId === null ? empty : (state[sessionId] ?? empty);

  const update = (sessionId: string, updater: (current: T) => T): void => {
    const current = select(store.state, sessionId);
    const next = updater(current);
    if (next === current) return;
    store.setState((state) => ({ ...state, [sessionId]: next }));
  };

  const drop = (sessionId: string): void => {
    store.setState((state) => {
      if (!(sessionId in state)) return state;
      const rest = { ...state };
      delete rest[sessionId];
      return rest;
    });
  };

  const reset = (): void => {
    store.setState(() => ({}));
  };

  const channel = <Payload>(options: SessionStoreChannel<T, Payload>): SessionChannelContribution =>
    defineSessionChannel<Payload>({
      channel: options.channel,
      parse: (input) => options.parse(input),
      apply(sessionId, payload) {
        update(sessionId, (current) => options.reduce(current, payload));
      },
      drop,
    });

  return { store, select, update, drop, reset, channel };
}
