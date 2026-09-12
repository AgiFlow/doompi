import { afterEach, expect, it, vi } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type {
  SessionServiceState,
  TranscriptPageRequest,
} from '@agimon-ai/doompi-extension-contracts/session-protocol';
import { createPagedTranscript } from '../../src/web/stores/pagedTranscriptStore.ts';
import {
  applySessionFrame,
  dropSessionStore,
  requestOlderHistory,
  requestNewerHistory,
  sessionStoreFor,
} from '../../src/web/stores/sessionStore.ts';

const id = 'paged-test';
afterEach(() => dropSessionStore(id));

function fixture() {
  const entries = Array.from({ length: 1000 }, (_, seq) => ({
    type: 'message',
    id: `e${seq}`,
    seq,
    parentId: seq ? `e${seq - 1}` : null,
    timestamp: seq,
    message: { role: 'user', content: `message ${seq}`, timestamp: seq },
  }));
  const read = vi.fn(async (request: TranscriptPageRequest) => {
    const position = request.cursor === undefined ? entries.length : Number(request.cursor);
    const start = request.direction === 'newer' ? position + 1 : Math.max(0, position - 100);
    const end = Math.min(start + 100, entries.length);
    return {
      entries: entries.slice(start, end),
      context: [],
      drafts: [],
      generation: 0,
      revision: 0,
      startCursor: String(start),
      endCursor: String(end - 1),
      olderCursor: start ? String(start) : null,
      newerCursor: end < entries.length ? String(end - 1) : null,
    };
  });
  const transcript = createPagedTranscript(
    id,
    { readTranscriptPage: read },
    (key, frame, replay) => applySessionFrame(key, frame, { replay }),
    BACKGROUND_CONTEXT,
  );
  return { transcript, read, entries };
}

it('evicts old pages at 500 records and can load evicted newer pages without duplicates', async () => {
  const { transcript, read } = fixture();
  try {
    await transcript.initialize();
    for (let page = 0; page < 6; page++) {
      expect(requestOlderHistory(id)).toBe(true);
      await vi.waitFor(() => expect(sessionStoreFor(id).state.entries[0]?.id).toBe(`e${800 - page * 100}`));
      expect(sessionStoreFor(id).state.entries.length).toBeLessThanOrEqual(500);
    }
    expect(sessionStoreFor(id).state.hasNewerHistory).toBe(true);
    expect(requestNewerHistory(id)).toBe(true);
    await vi.waitFor(() => expect(sessionStoreFor(id).state.entries.at(-1)?.id).toBe('e899'));
    const items = sessionStoreFor(id).state.entries;
    expect(items).toHaveLength(500);
    expect(new Set(items.map((entry) => entry.id)).size).toBe(500);
    expect(read).toHaveBeenLastCalledWith({ cursor: '799', direction: 'newer' }, BACKGROUND_CONTEXT);
  } finally {
    transcript.dispose();
  }
});

it('deduplicates a commit also returned by the page and recovers a missing live event by rereading a bounded page', async () => {
  const { transcript, read, entries } = fixture();
  const publish = (sequence: number) =>
    transcript.publish({
      snapshot: { phase: 'idle' },
      progress: null,
      presentation: {
        revision: sequence,
        events: [{ sequence, frame: { type: 'entry_appended', entry: entries[999]!, transcriptCursor: '999' } }],
        projections: [],
        dropped: 0,
      },
    } as unknown as SessionServiceState);
  try {
    await transcript.initialize();
    publish(1);
    expect(sessionStoreFor(id).state.entries.filter((entry) => entry.id === 'e999')).toHaveLength(1);
    publish(3);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(sessionStoreFor(id).state.entries.length).toBeLessThanOrEqual(100);
  } finally {
    transcript.dispose();
  }
});
