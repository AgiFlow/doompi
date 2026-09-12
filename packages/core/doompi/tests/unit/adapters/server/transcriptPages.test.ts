import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import type { Write } from '@earendil-works/pi-agent-core/harness/session';
import { openSqliteSessionStorage } from '../../../../src/services/sqliteSessionStorage';
import { readSqliteTranscript } from '../../../../src/services/sqliteTranscriptReader';
import { readTranscriptPage } from '../../../../src/services/transcriptPages';
import { createHistoryOwnership } from '../../../../src/services/historyOwnership';

it('keeps indexed pages bounded at 1k, 10k and 100k entries, with bidirectional cursors and read-only child access', async () => {
  const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-pages-'));
  const storage = await openSqliteSessionStorage(
    { sessionsRoot, sessionId: 'pages', historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }) },
    BACKGROUND_CONTEXT,
  );
  try {
    const branch = await storage.session.createBranch('main', null, BACKGROUND_CONTEXT);
    const reader = { sessionId: 'pages', laneName: 'main', lane: branch };
    let count = 0;
    for (const size of [1_000, 10_000, 100_000]) {
      while (count < size) {
        const writes: Write[] = [];
        for (const end = Math.min(count + 1_000, size); count < end; count++)
          writes.push({
            kind: 'entry',
            entry: {
              type: 'message',
              id: `e${count}`,
              parentId: count ? `e${count - 1}` : null,
              message: { role: 'user', content: `message ${count}`, timestamp: count },
            },
          });
        writes.push({ kind: 'value', namespace: 'pi.branch.tip', key: 'main', op: 'set', value: `e${count - 1}` });
        await storage.session.mutate(
          (mutation, context) => mutation.commit(writes, context).then(() => undefined),
          BACKGROUND_CONTEXT,
        );
      }
      const started = performance.now();
      const page = await readTranscriptPage(reader, {}, 0, BACKGROUND_CONTEXT);
      console.info(
        JSON.stringify({
          metric: 'transcript_page',
          history_entries: size,
          page_entries: page.entries.length,
          duration_ms: performance.now() - started,
          bytes: JSON.stringify(page).length,
        }),
      );
      expect(page.entries).toHaveLength(100);
      expect(page.entries[0]).toMatchObject({ id: `e${size - 100}` });
      expect(page.entries.at(-1)).toMatchObject({ id: `e${size - 1}` });
      expect(page.newerCursor).toBeNull();
      const older = await readTranscriptPage(
        reader,
        { cursor: page.olderCursor!, direction: 'older' },
        0,
        BACKGROUND_CONTEXT,
      );
      expect(older.entries.at(-1)).toMatchObject({ id: `e${size - 101}` });
      const newer = await readTranscriptPage(
        reader,
        { cursor: older.newerCursor!, direction: 'newer' },
        0,
        BACKGROUND_CONTEXT,
      );
      expect(newer.entries).toEqual(page.entries);
      await expect(readTranscriptPage(reader, { cursor: page.olderCursor! }, 1, BACKGROUND_CONTEXT)).rejects.toThrow(
        'STALE_TRANSCRIPT_CURSOR',
      );
      await expect(
        readTranscriptPage({ ...reader, sessionId: 'other' }, { cursor: page.olderCursor! }, 0, BACKGROUND_CONTEXT),
      ).rejects.toThrow('Invalid transcript cursor');
      await expect(readTranscriptPage(reader, { limit: 101 }, 0, BACKGROUND_CONTEXT)).rejects.toThrow('limit');
      const child = await readSqliteTranscript(storage.sessionFile, {}, BACKGROUND_CONTEXT);
      expect(child.entries).toEqual(page.entries);
    }
  } finally {
    await storage.session.close(BACKGROUND_CONTEXT);
    await storage.repository.close(BACKGROUND_CONTEXT);
    await storage.historyLease.release();
    await fs.rm(sessionsRoot, { recursive: true, force: true });
  }
}, 120_000);
