import { Store } from '@tanstack/store';

/** Dialogs can observe their target without taking focus or stealing another observer's subscription. */
export const heldSessionChannels = new Store<ReadonlyMap<string, number>>(new Map());

const observers = new Set<{ sessionId: string; receive: (frame: Record<string, unknown>) => void }>();

export function holdSessionChannels(sessionId: string, receive?: (frame: Record<string, unknown>) => void): () => void {
  const observer = receive === undefined ? undefined : { sessionId, receive };
  if (observer) observers.add(observer);
  heldSessionChannels.setState((current) => new Map(current).set(sessionId, (current.get(sessionId) ?? 0) + 1));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (observer) observers.delete(observer);
    heldSessionChannels.setState((current) => {
      const next = new Map(current);
      const remaining = (next.get(sessionId) ?? 1) - 1;
      if (remaining === 0) next.delete(sessionId);
      else next.set(sessionId, remaining);
      return next;
    });
  };
}

/** Deliver to the observing dialog's composition, even when the target has never been focused. */
export function dispatchHeldSessionChannel(frame: Record<string, unknown>): void {
  if (typeof frame.type !== 'string' || typeof frame.sessionId !== 'string') return;
  for (const observer of observers) {
    if (observer.sessionId !== frame.sessionId) continue;
    try {
      observer.receive(frame);
    } catch (error) {
      console.error('Session channel observer failed', error);
    }
  }
}
