import type {
  SessionServiceState,
  TranscriptPage,
  TranscriptPageRequest,
} from '@agimon-ai/doompi-core/session-protocol';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { afterEach, expect, it, vi } from 'vitest';

import { createPagedTranscript } from '../../src/web/stores/pagedTranscriptStore';
import {
  applySessionFrame,
  dropSessionStore,
  requestOlderHistory,
  requestNewerHistory,
  sessionStoreFor,
} from '../../src/web/stores/sessionStore';

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
  const read = vi.fn(async (request: TranscriptPageRequest): Promise<TranscriptPage> => {
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

it('rereads the authoritative page when an assistant message commits', async () => {
  const { transcript, read } = fixture();
  try {
    await transcript.initialize();
    transcript.publish({
      snapshot: { phase: 'idle' },
      progress: null,
      presentation: {
        revision: 1,
        events: [{ sequence: 1, frame: { type: 'message_end', message: { role: 'assistant' } } }],
        projections: [],
        dropped: 0,
      },
    } as unknown as SessionServiceState);

    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  } finally {
    transcript.dispose();
  }
});

it('rolls a full live page forward, keeps profile context, and ignores duplicate commits', async () => {
  const { transcript, read, entries } = fixture();
  const originalRead = read.getMockImplementation()!;
  const identity = { id: 'profile', customType: 'doom-profile-identity', data: { profile: 'default' } };
  read.mockImplementationOnce(async (request) => ({ ...(await originalRead(request)), context: [identity] }));
  try {
    await transcript.initialize();
    const entry = { ...entries[999]!, id: 'e1000', seq: 1000 };
    const publish = (sequence: number) =>
      transcript.publish({
        snapshot: { phase: 'idle' },
        progress: null,
        presentation: {
          revision: sequence,
          events: [{ sequence, frame: { type: 'entry_appended', entry, transcriptCursor: '1000' } }],
          projections: [],
          dropped: 0,
        },
      } as unknown as SessionServiceState);
    publish(1);
    publish(2);
    expect(sessionStoreFor(id).state.entries.filter((item) => item.id === 'e1000')).toHaveLength(1);
    expect(sessionStoreFor(id).state.entries.length).toBe(101);
  } finally {
    transcript.dispose();
  }
});

it('replays projections, context, and live drafts only at the latest page', async () => {
  const frames: Array<Record<string, unknown>> = [];
  const page: TranscriptPage = {
    entries: [],
    context: [{ id: 'context', customType: 'context' }],
    drafts: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'answer' },
          { type: 'thinking', thinking: 'plan' },
        ],
      },
      { role: 'tool', toolCallId: 'call-1', toolName: 'read', input: {}, content: [{ type: 'text', text: 'file' }] },
    ],
    generation: 0,
    revision: 3,
    startCursor: null,
    endCursor: null,
    olderCursor: null,
    newerCursor: null,
  } as unknown as TranscriptPage;
  const read = vi.fn(async () => page);
  const transcript = createPagedTranscript(
    id,
    { readTranscriptPage: read },
    (_id, frame) => frames.push(frame),
    BACKGROUND_CONTEXT,
  );
  try {
    transcript.publish({
      snapshot: { phase: 'turn' },
      progress: null,
      presentation: {
        revision: 3,
        events: [],
        projections: [{ frame: { type: 'status', text: 'ready' } }],
        dropped: 0,
      },
    } as unknown as SessionServiceState);
    await transcript.initialize();
    expect(frames.map((frame) => frame.type)).toEqual([
      'status',
      'entry_appended',
      'message_update',
      'message_update',
      'tool_execution_start',
      'tool_execution_update',
      'agent_start',
    ]);
  } finally {
    transcript.dispose();
  }
});

it('buffers live commits before the first page and reloads when presentation revision resets', async () => {
  const { transcript, read, entries } = fixture();
  try {
    transcript.publish({
      snapshot: { phase: 'idle' },
      progress: null,
      presentation: {
        revision: 5,
        events: [{ sequence: 1, frame: { type: 'entry_appended', entry: { ...entries[999]!, id: 'e1000' } } }],
        projections: [],
        dropped: 0,
      },
    } as unknown as SessionServiceState);
    await transcript.initialize();
    expect(sessionStoreFor(id).state.entries.some((entry) => entry.id === 'e1000')).toBe(true);
    transcript.publish({
      snapshot: { phase: 'idle' },
      progress: null,
      presentation: { revision: 4, events: [], projections: [], dropped: 0 },
    } as unknown as SessionServiceState);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  } finally {
    transcript.dispose();
  }
});

it('recovers stale cursors and surfaces other page errors', async () => {
  const frames: Array<Record<string, unknown>> = [];
  const { transcript: unused, read, entries } = fixture();
  unused.dispose();
  const transcript = createPagedTranscript(
    id,
    { readTranscriptPage: read },
    (_id, frame) => frames.push(frame),
    BACKGROUND_CONTEXT,
  );
  try {
    await transcript.initialize();
    expect(requestNewerHistory(id)).toBe(false);
    read.mockRejectedValueOnce(new Error('STALE_TRANSCRIPT_CURSOR'));
    expect(requestOlderHistory(id)).toBe(true);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    read.mockRejectedValueOnce(new Error('page unavailable'));
    expect(requestOlderHistory(id)).toBe(true);
    await vi.waitFor(() => expect(frames).toContainEqual({ type: 'error', message: 'page unavailable' }));
    expect(frames.filter((frame) => frame.type === 'entry_appended')).toHaveLength(entries.slice(900).length * 2);
  } finally {
    transcript.dispose();
  }
});

it('ignores live stream frames while viewing old pages and returns to latest after navigation', async () => {
  const { transcript, read, entries } = fixture();
  try {
    await transcript.initialize();
    for (let page = 0; page < 6; page++) {
      expect(requestOlderHistory(id)).toBe(true);
      await vi.waitFor(() => expect(sessionStoreFor(id).state.entries[0]?.id).toBe(`e${800 - page * 100}`));
    }
    const priorCount = read.mock.calls.length;
    transcript.publish({
      snapshot: { phase: 'idle' },
      progress: null,
      presentation: {
        revision: 3,
        events: [
          {
            sequence: 1,
            frame: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'live' } },
          },
          { sequence: 2, frame: { type: 'entry_appended', entry: { ...entries[999]!, id: 'e1000' } } },
          { sequence: 3, frame: { type: 'navigation_end' } },
        ],
        projections: [],
        dropped: 0,
      },
    } as unknown as SessionServiceState);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(priorCount + 1));
    expect(sessionStoreFor(id).state.entries.at(-1)?.id).toBe('e999');
  } finally {
    transcript.dispose();
  }
});

it('reloads after the pre-initialization event buffer overflows and ignores updates after disposal', async () => {
  const { transcript, read, entries } = fixture();
  try {
    transcript.publish({
      snapshot: { phase: 'idle' },
      progress: null,
      presentation: {
        revision: 514,
        events: Array.from({ length: 514 }, (_, index) => ({
          sequence: index + 1,
          frame: { type: 'entry_appended', entry: { ...entries[999]!, id: `live-${index}` } },
        })),
        projections: [],
        dropped: 0,
      },
    } as unknown as SessionServiceState);
    await transcript.initialize();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  } finally {
    transcript.dispose();
  }
  transcript.publish({
    snapshot: { phase: 'idle' },
    progress: null,
    presentation: { revision: 515, events: [], projections: [], dropped: 0 },
  } as unknown as SessionServiceState);
  expect(read).toHaveBeenCalledTimes(2);
});

it('defers navigation reload while the initial page is loading and drops repeated buffered events', async () => {
  const { transcript, read } = fixture();
  const initial = read.getMockImplementation()!;
  let finish!: (page: TranscriptPage) => void;
  read.mockImplementationOnce(
    () =>
      new Promise<TranscriptPage>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    const loading = transcript.initialize();
    expect(requestOlderHistory(id)).toBe(false);
    const state = {
      snapshot: { phase: 'idle' },
      progress: null,
      presentation: {
        revision: 1,
        events: [{ sequence: 1, frame: { type: 'navigation_end' } }],
        projections: [],
        dropped: 0,
      },
    } as unknown as SessionServiceState;
    transcript.publish(state);
    transcript.publish(state);
    finish(await initial({}));
    await loading;
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(sessionStoreFor(id).state.entries.at(-1)?.id).toBe('e999');
  } finally {
    transcript.dispose();
  }
});
