import { subscribeThreadFrame, unsubscribeThreadFrame } from '../../types/hub.ts';
import { sendHubFrame } from '../lib/transport.ts';
import { dropSessionStore } from './sessionStore.ts';

/** A session id is a registry id and never starts with this, so a thread's fold cannot shadow a session's. */
const THREAD_KEY_PREFIX = 'thread:';

interface ThreadHold {
  sessionId: string;
  threadId: string;
  refs: number;
}

/**
 * The page's holds on threads, counted per thread so two views of one thread
 * share a subscription. The hub-side subscription dies with the socket, so
 * this is also what a reconnect replays.
 */
const holds = new Map<string, ThreadHold>();

/** Where a thread's fold lives in the session store map. */
export function threadStoreKey(sessionId: string, threadId: string): string {
  return `${THREAD_KEY_PREFIX}${sessionId}:${threadId}`;
}

export function subscribeThread(sessionId: string, threadId: string): void {
  const key = threadStoreKey(sessionId, threadId);
  const held = holds.get(key);
  if (held !== undefined) {
    held.refs += 1;
    return;
  }
  holds.set(key, { sessionId, threadId, refs: 1 });
  sendHubFrame(subscribeThreadFrame(sessionId, threadId));
}

export function unsubscribeThread(sessionId: string, threadId: string): void {
  const key = threadStoreKey(sessionId, threadId);
  const held = holds.get(key);
  if (held === undefined) return;
  held.refs -= 1;
  if (held.refs > 0) return;
  holds.delete(key);
  sendHubFrame(unsubscribeThreadFrame(sessionId, threadId));
}

/** A fresh socket knows nothing; every held thread is asked for again. */
export function resubscribeThreads(): void {
  for (const held of holds.values()) sendHubFrame(subscribeThreadFrame(held.sessionId, held.threadId));
}

/** A session that left takes its threads' folds and holds with it. */
export function dropThreads(sessionId: string): void {
  for (const [key, held] of holds) {
    if (held.sessionId !== sessionId) continue;
    holds.delete(key);
    dropSessionStore(key);
  }
}

/** The threads currently held, for tests and diagnostics. */
export function heldThreads(): Array<{ sessionId: string; threadId: string; refs: number }> {
  return [...holds.values()].map((held) => ({ ...held }));
}

export function resetThreads(): void {
  holds.clear();
}
