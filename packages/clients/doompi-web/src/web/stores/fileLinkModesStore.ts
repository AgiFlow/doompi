import { bindFileLinkModes, minorModes } from '../lib/composition.ts';
import { sessionStoreFor } from './sessionStore.ts';

/** Supplies live mode facts to file routing, including already-rendered links. */
export function bindSessionFileLinkModes(): () => void {
  return bindFileLinkModes({
    active(sessionId) {
      const state = sessionStoreFor(sessionId).state;
      return minorModes(state.statuses, state.widgets, state.minorModes)
        .filter((mode) => mode.availability === 'on')
        .map((mode) => mode.name);
    },
    subscribe(sessionId, listener) {
      const subscription = sessionStoreFor(sessionId).subscribe(listener);
      return () => subscription.unsubscribe();
    },
  });
}
