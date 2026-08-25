import fs from 'node:fs';
import path from 'node:path';
import { journalFrames, retainNewest } from '../services/journalTail.ts';
import type { SessionFrame } from '../types/session.ts';

const DEFAULT_POLL_MS = 1000;
/** Journalled messages kept per thread, the same allowance an attach restores. */
const DEFAULT_RETAIN_LIMIT = 300;
/** How far back a first read goes into a long journal; older lines stay on disk. */
const DEFAULT_MAX_INITIAL_BYTES = 8 * 1024 * 1024;
const JOURNAL_EXTENSION = '.jsonl';
const NEWLINE = 0x0a;

export interface ThreadFrameEvent {
  sessionId: string;
  threadId: string;
  frame: SessionFrame;
}

export interface ThreadJournalsOptions {
  /** Names the journal of one thread, or undefined while no source knows it yet. */
  resolve(sessionId: string, threadId: string): string | undefined;
  pollMs?: number;
  retainLimit?: number;
  maxInitialBytes?: number;
  onNotice?: (message: string) => void;
}

export interface ThreadJournals {
  /** Follows the thread for one more subscriber and returns its retained history, oldest first. */
  subscribe(sessionId: string, threadId: string): SessionFrame[];
  unsubscribe(sessionId: string, threadId: string): void;
  /** Live frames of every followed thread; the return value stops listening. */
  onFrame(listener: (event: ThreadFrameEvent) => void): () => void;
  close(): void;
}

interface Tail {
  sessionId: string;
  threadId: string;
  refs: number;
  /** Unknown until a source names the journal; asked again on every tick. */
  path: string | undefined;
  /** The byte after the last complete line read, so a torn line is re-read whole. */
  offset: number;
  retained: SessionFrame[];
  warned: boolean;
}

function keyOf(sessionId: string, threadId: string): string {
  return `${sessionId}\n${threadId}`;
}

/** Bytes [start, end) of a file, or undefined when it cannot be read right now. */
function readRange(file: string, start: number, end: number): Buffer | undefined {
  const buffer = Buffer.alloc(end - start);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const read = fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.subarray(0, read);
  } catch {
    // The writer may be rotating or the file may have gone; the next tick looks again.
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Tails Pi session journals for the pages following them.
 *
 * A thread is any journal a data channel can name for a session, such as a
 * subagent run's own session file. The hub reads only what the file gained
 * since the last look and stops at the last newline, so a line the writer is
 * still appending is never folded half-way; a file that shrank is read from
 * the start again, which is harmless because the page dedupes entries by id.
 */
export function createThreadJournals(options: ThreadJournalsOptions): ThreadJournals {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const retainLimit = options.retainLimit ?? DEFAULT_RETAIN_LIMIT;
  const maxInitialBytes = options.maxInitialBytes ?? DEFAULT_MAX_INITIAL_BYTES;
  const notice = options.onNotice ?? ((): void => {});
  const tails = new Map<string, Tail>();
  const listeners = new Set<(event: ThreadFrameEvent) => void>();
  let timer: NodeJS.Timeout | undefined;

  const journalPathOf = (tail: Tail): string | undefined => {
    const candidate = options.resolve(tail.sessionId, tail.threadId);
    if (candidate === undefined) return undefined;
    if (path.isAbsolute(candidate) && candidate.endsWith(JOURNAL_EXTENSION)) return candidate;
    if (!tail.warned) {
      tail.warned = true;
      notice(`thread ${tail.threadId} of session ${tail.sessionId} names '${candidate}', which is not a journal`);
    }
    return undefined;
  };

  /** Folds what the journal gained since the last look and returns the new frames. */
  const advance = (tail: Tail): SessionFrame[] => {
    tail.path ??= journalPathOf(tail);
    if (tail.path === undefined) return [];
    let size: number;
    try {
      size = fs.statSync(tail.path).size;
    } catch {
      // Not written yet, or gone: the thread stays empty until the next tick finds it.
      return [];
    }
    if (size < tail.offset) {
      tail.offset = 0;
      tail.retained = [];
    }
    let start = tail.offset;
    let cut = false;
    if (start === 0 && size > maxInitialBytes) {
      start = size - maxInitialBytes;
      cut = true;
    }
    if (size <= start) return [];
    const chunk = readRange(tail.path, start, size);
    if (chunk === undefined) return [];
    const lastNewline = chunk.lastIndexOf(NEWLINE);
    if (lastNewline === -1) return [];
    // A cut lands mid-line; the line it tore is dropped rather than misread.
    const firstLine = cut ? chunk.indexOf(NEWLINE) + 1 : 0;
    const frames = firstLine > lastNewline ? [] : journalFrames(chunk.toString('utf8', firstLine, lastNewline + 1));
    tail.offset = start + lastNewline + 1;
    if (frames.length > 0) tail.retained = retainNewest([...tail.retained, ...frames], retainLimit);
    return frames;
  };

  const tick = (): void => {
    for (const tail of tails.values()) {
      const frames = advance(tail);
      for (const frame of frames) {
        for (const listener of listeners) listener({ sessionId: tail.sessionId, threadId: tail.threadId, frame });
      }
    }
  };

  const syncTimer = (): void => {
    if (tails.size > 0 && timer === undefined) timer = setInterval(tick, pollMs);
    if (tails.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return {
    subscribe(sessionId, threadId) {
      const key = keyOf(sessionId, threadId);
      let tail = tails.get(key);
      if (tail === undefined) {
        tail = { sessionId, threadId, refs: 0, path: undefined, offset: 0, retained: [], warned: false };
        tails.set(key, tail);
        advance(tail);
        syncTimer();
      }
      tail.refs += 1;
      return [...tail.retained];
    },
    unsubscribe(sessionId, threadId) {
      const key = keyOf(sessionId, threadId);
      const tail = tails.get(key);
      if (tail === undefined) return;
      tail.refs -= 1;
      if (tail.refs <= 0) tails.delete(key);
      syncTimer();
    },
    onFrame(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      tails.clear();
      listeners.clear();
    },
  };
}
