import { subscribeThreadFrame, unsubscribeThreadFrame } from '../../types/hub.ts';
import { sendHubFrame } from '../lib/transport.ts';
import { applySessionFrame, dropSessionStore } from './sessionStore.ts';
import type { Context } from '@earendil-works/chord';
import type { SessionService, SessionServiceState } from '@agimon-ai/doompi-extension-contracts/session-protocol';
import { createPagedTranscript } from './pagedTranscriptStore.ts';

/** A session id is a registry id and never starts with this, so a thread's fold cannot shadow a session's. */
const THREAD_KEY_PREFIX = 'thread:';

interface ThreadHold {
  sessionId: string;
  threadId: string;
  refs: number;
  transcript?: ReturnType<typeof createPagedTranscript>;
  pendingState?: SessionServiceState;
  ready?: boolean;
}

/**
 * The page's holds on threads, counted per thread so two views of one thread
 * share a subscription. The hub-side subscription dies with the socket, so
 * this is also what a reconnect replays.
 */
const holds = new Map<string, ThreadHold>();
const readers = new Map<string, { service: SessionService; context: Context }>();

function startTranscript(held: ThreadHold): void {
  if (held.transcript || !held.ready) return;
  const reader = readers.get(held.sessionId);
  if (!reader) return;
  const key = threadStoreKey(held.sessionId, held.threadId);
  const transcript = createPagedTranscript(
    key,
    {
      readTranscriptPage: (request, context) =>
        reader.service.readTranscriptPage({ ...request, threadId: held.threadId }, context),
    },
    (id, frame, replay) => applySessionFrame(id, frame, { replay }),
    reader.context,
  );
  held.transcript = transcript;
  if (held.pendingState) transcript.publish(held.pendingState);
  void transcript.initialize().catch((error: unknown) => {
    if (held.transcript === transcript) applySessionFrame(key, { type: 'error', message: String(error) });
  });
}

export function bindThreadReader(sessionId: string, service: SessionService, context: Context): () => void {
  const reader = { service, context };
  readers.set(sessionId, reader);
  for (const held of holds.values()) if (held.sessionId === sessionId) startTranscript(held);
  return () => {
    if (readers.get(sessionId) !== reader) return;
    readers.delete(sessionId);
    for (const held of holds.values())
      if (held.sessionId === sessionId) {
        held.transcript?.dispose();
        held.transcript = undefined;
      }
  };
}

/** SQLite children use the same cursor window and delta reducer as their parent. */
export function applyThreadTranscriptFrame(
  sessionId: string,
  threadId: string,
  frame: Record<string, unknown>,
): boolean {
  if (frame.type !== 'transcript_state' && frame.type !== 'transcript_ready') return false;
  const held = holds.get(threadStoreKey(sessionId, threadId));
  if (!held) return true;
  held.ready = true;
  if (frame.type === 'transcript_state') held.pendingState = frame.state as SessionServiceState;
  startTranscript(held);
  if (held.pendingState) held.transcript?.publish(held.pendingState);
  return true;
}

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
  held.transcript?.dispose();
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
    held.transcript?.dispose();
    dropSessionStore(key);
  }
}

/** The threads currently held, for tests and diagnostics. */
export function heldThreads(): Array<{ sessionId: string; threadId: string; refs: number }> {
  return [...holds.values()].map((held) => ({ ...held }));
}

export function resetThreads(): void {
  for (const held of holds.values()) held.transcript?.dispose();
  holds.clear();
  readers.clear();
}
