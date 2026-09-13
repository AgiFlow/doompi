import fs from 'node:fs';
import path from 'node:path';

import type { Context } from '@earendil-works/chord';

import type { TranscriptPage, TranscriptPageRequest } from '../exports/sessionProtocol';
import { readSqliteTranscript } from '../services/sqliteTranscriptReader';
import { nativeChildRuntime } from '../systems/child/adapters/nativeChildRuntimes';

const POLL_MS = 250;
const RETAIN_LIMIT = 300;
const MAX_INITIAL_BYTES = 8 * 1024 * 1024;
const NEWLINE = 0x0a;

type Frame = Record<string, unknown>;

interface Tail {
  readonly sessionId: string;
  readonly threadId: string;
  refs: number;
  file: string | undefined;
  offset: number;
  retained: Frame[];
  stop?: () => void;
}

export interface ThreadJournals {
  readPage(
    sessionId: string,
    threadId: string,
    request: TranscriptPageRequest,
    context: Context,
  ): Promise<TranscriptPage>;
  subscribe(sessionId: string, threadId: string): Frame[];
  unsubscribe(sessionId: string, threadId: string): void;
  onFrame(listener: (event: { sessionId: string; threadId: string; frame: Frame }) => void): () => void;
  close(): void;
}

function keyOf(sessionId: string, threadId: string): string {
  return `${sessionId}\n${threadId}`;
}

function journalFrames(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const line of text.split('\n')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const row of rows) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
      const entry = row as Record<string, unknown>;
      const isLegacyMessage = entry.type === 'message';
      const isCurrentMessage = entry.kind === 'entry' && entry.type === 'message';
      if (
        (!isLegacyMessage && !isCurrentMessage) ||
        typeof entry.id !== 'string' ||
        typeof entry.message !== 'object'
      ) {
        continue;
      }
      frames.push({ type: 'entry_appended', entry });
    }
  }
  return frames;
}

function readRange(file: string, start: number, end: number): Buffer | undefined {
  const buffer = Buffer.alloc(end - start);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, 'r');
    return buffer.subarray(0, fs.readSync(descriptor, buffer, 0, buffer.length, start));
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** Tails child journals only while at least one browser thread is subscribed. */
export function createThreadJournals(options: {
  resolve(sessionId: string, threadId: string): string | undefined;
}): ThreadJournals {
  const tails = new Map<string, Tail>();
  const listeners = new Set<(event: { sessionId: string; threadId: string; frame: Frame }) => void>();
  let timer: NodeJS.Timeout | undefined;

  const advance = (tail: Tail): Frame[] => {
    const candidate = tail.file ?? options.resolve(tail.sessionId, tail.threadId);
    if (candidate && path.isAbsolute(candidate) && path.extname(candidate) === '.sqlite') {
      tail.file = candidate;
      if (tail.stop) return [];
      const runtime = nativeChildRuntime(candidate);
      if (runtime) {
        tail.stop = runtime.state.subscribe((state) => {
          const frame = { type: 'transcript_state', state };
          tail.retained = [frame];
          for (const listener of listeners) listener({ sessionId: tail.sessionId, threadId: tail.threadId, frame });
        });
        tail.retained = [{ type: 'transcript_state', state: runtime.state.state }];
      } else tail.retained = [{ type: 'transcript_ready' }];
      return tail.retained;
    }
    if (candidate === undefined || !path.isAbsolute(candidate) || path.extname(candidate) !== '.jsonl') return [];
    tail.file = candidate;
    let size: number;
    try {
      size = fs.statSync(candidate).size;
    } catch {
      return [];
    }
    if (size < tail.offset) {
      tail.offset = 0;
      tail.retained = [];
    }
    const cut = tail.offset === 0 && size > MAX_INITIAL_BYTES;
    const start = cut ? size - MAX_INITIAL_BYTES : tail.offset;
    if (size <= start) return [];
    const chunk = readRange(candidate, start, size);
    if (chunk === undefined) return [];
    const lastNewline = chunk.lastIndexOf(NEWLINE);
    if (lastNewline < 0) return [];
    const first = cut ? chunk.indexOf(NEWLINE) + 1 : 0;
    const frames = first > lastNewline ? [] : journalFrames(chunk.toString('utf8', first, lastNewline + 1));
    tail.offset = start + lastNewline + 1;
    if (frames.length > 0) tail.retained = [...tail.retained, ...frames].slice(-RETAIN_LIMIT);
    return frames;
  };
  const tick = (): void => {
    for (const tail of tails.values()) {
      for (const frame of advance(tail)) {
        for (const listener of listeners) listener({ sessionId: tail.sessionId, threadId: tail.threadId, frame });
      }
    }
  };
  const syncTimer = (): void => {
    if (tails.size > 0 && timer === undefined) timer = setInterval(tick, POLL_MS);
    if (tails.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return {
    async readPage(sessionId, threadId, request, context) {
      const file = options.resolve(sessionId, threadId);
      if (!file || !path.isAbsolute(file) || path.extname(file) !== '.sqlite')
        throw new Error('Child SQLite transcript not found');
      const { threadId: _threadId, ...query } = request;
      const runtime = nativeChildRuntime(file);
      return runtime ? runtime.readTranscriptPage(query, context) : readSqliteTranscript(file, query, context);
    },
    subscribe(sessionId, threadId) {
      const key = keyOf(sessionId, threadId);
      const tail = tails.get(key) ?? {
        sessionId,
        threadId,
        refs: 0,
        file: undefined,
        offset: 0,
        retained: [],
      };
      if (!tails.has(key)) tails.set(key, tail);
      tail.refs += 1;
      advance(tail);
      syncTimer();
      return [...tail.retained];
    },
    unsubscribe(sessionId, threadId) {
      const key = keyOf(sessionId, threadId);
      const tail = tails.get(key);
      if (tail === undefined) return;
      tail.refs -= 1;
      if (tail.refs <= 0) {
        tail.stop?.();
        tails.delete(key);
      }
      syncTimer();
    },
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      for (const tail of tails.values()) tail.stop?.();
      tails.clear();
      listeners.clear();
    },
  };
}
