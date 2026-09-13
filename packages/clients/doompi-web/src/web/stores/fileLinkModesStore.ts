import { bindFileLinkModes, minorModes } from '../lib/composition';
import { sessionStoreFor } from './sessionStore';

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
