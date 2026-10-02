import { expect, it, vi } from 'vitest';

import { DURABLE_BACKGROUND_CONTEXT as context } from '../../../../../src/services/sqliteSessionStorage';
import { readTranscriptPage, type TranscriptEntryQuery } from '../../../../../src/services/transcriptPages';
import type { Entry } from '../../../../../src/types/server/directHarnessRuntime';

it('bounds protocol pages and supports bidirectional, lane-relative cursors', async () => {
  const entries: Entry[] = Array.from({ length: 200 }, (_, index) => ({
    id: String(index + 1),
    parentId: index ? String(index) : null,
    seq: index + 1,
    timestamp: index,
    type: 'message',
    message: { role: 'user', content: `message ${index}`, timestamp: index },
  }));
  const findEntries = vi.fn(async (query: TranscriptEntryQuery) => {
    let rows = entries;
    if (query.cursor)
      rows = rows.filter((entry) =>
        query.order === 'oldestFirst' ? entry.seq > query.cursor!.seq : entry.seq < query.cursor!.seq,
      );
    if (query.type) rows = rows.filter((entry) => entry.type === query.type);
    if (query.order !== 'oldestFirst') rows = [...rows].reverse();
    return rows.slice(0, query.limit);
  });
  const reader = { sessionId: 'session', laneName: '2', lane: { getTipId: async () => '200', findEntries } };
  const newest = await readTranscriptPage(reader, { limit: 20 }, 0, context);
  expect(newest.entries).toHaveLength(20);
  expect(newest.entries[0]).toMatchObject({ id: '181' });
  expect(findEntries.mock.calls[0]![0].limit).toBe(21);
  const older = await readTranscriptPage(reader, { limit: 20, cursor: newest.olderCursor! }, 0, context);
  expect(older.entries[0]).toMatchObject({ id: '161' });
  const newer = await readTranscriptPage(
    reader,
    { limit: 20, cursor: older.newerCursor!, direction: 'newer' },
    0,
    context,
  );
  expect(newer.entries).toEqual(newest.entries);
  await expect(readTranscriptPage(reader, { cursor: newest.olderCursor! }, 1, context)).rejects.toThrow(
    'STALE_TRANSCRIPT_CURSOR',
  );
  await expect(
    readTranscriptPage({ ...reader, laneName: '3' }, { cursor: newest.olderCursor! }, 0, context),
  ).rejects.toThrow('Invalid transcript cursor');
  await expect(readTranscriptPage(reader, { limit: 101 }, 0, context)).rejects.toThrow('between 1 and 100');
});
