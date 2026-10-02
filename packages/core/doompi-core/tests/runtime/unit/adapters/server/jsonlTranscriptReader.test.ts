import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { readJsonlTranscript } from '../../../../../src/server/jsonlTranscriptReader';
import { readNativeChildTranscript } from '../../../../../src/server/nativeChildTranscriptReader';
import { DurableNavigationDoc } from '../../../../../src/services/durableNavigation';
import { createHistoryOwnership } from '../../../../../src/services/historyOwnership';
import {
  DURABLE_BACKGROUND_CONTEXT as context,
  openSqliteSessionStorage,
  SessionMetadataDoc,
} from '../../../../../src/services/sqliteSessionStorage';
import { readSqliteTranscript } from '../../../../../src/services/sqliteTranscriptReader';

it('rejects the retained legacy JSONL entrypoint without reading it', async () => {
  await expect(readJsonlTranscript('/missing.jsonl', {})).rejects.toThrow('unsupported');
  await expect(readNativeChildTranscript('/missing.jsonl', {})).rejects.toThrow('unsupported');
});

it('reads a completed durable transcript with stable string identities and workspace authorization', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-transcript-'));
  try {
    const opened = await openSqliteSessionStorage(
      { sessionsRoot: root, sessionId: 'saved', historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }) },
      context,
    );
    await opened.session.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
      (await tx.doc(DurableNavigationDoc)).activeConversationId = conversation.id;
      const metadata = await tx.doc(SessionMetadataDoc);
      metadata.workspaceRoot = '/repo';
      metadata.execution = JSON.stringify({
        cwd: '/repo',
        repoRoot: '/repo',
        groupingRoot: '/repo',
        workspaceId: 'workspace',
      });
      await tx.appendEntry(conversation.id, { kind: 'doom-profile-identity', data: { name: 'profile' } });
      for (let index = 0; index < 5; index++)
        await tx.appendEntry(conversation.id, {
          kind: 'pi.user',
          model: [{ role: 'user', content: `message ${index}`, timestamp: 100 + index }],
        });
    }, context);
    await opened.repository.close(context);
    await opened.historyLease.release();
    const before = await fs.readFile(opened.sessionFile);
    const ownership = { sessionId: 'saved', workspaceRoot: '/repo', workspaceId: 'workspace', groupingRoot: '/repo' };
    const page = await readSqliteTranscript(opened.sessionFile, { limit: 2 }, context, ownership);
    expect((await readNativeChildTranscript(opened.sessionFile, { limit: 2 })).entries).toEqual(page.entries);
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]).toMatchObject({ type: 'message', message: { content: 'message 3' }, timestamp: 103 });
    expect(page.context).toHaveLength(1);
    const older = await readSqliteTranscript(
      opened.sessionFile,
      { limit: 2, cursor: page.olderCursor! },
      context,
      ownership,
    );
    expect(older.entries[0]).toMatchObject({ message: { content: 'message 1' } });
    expect(await fs.readFile(opened.sessionFile)).toEqual(before);
    await expect(
      readSqliteTranscript(opened.sessionFile, {}, context, { ...ownership, workspaceId: 'foreign' }),
    ).rejects.toThrow('workspace');
    await expect(
      readSqliteTranscript(opened.sessionFile, {}, context, { ...ownership, sessionId: 'foreign' }),
    ).rejects.toThrow('session');
    await expect(readSqliteTranscript(path.join(root, 'legacy.sqlite'), {}, context)).rejects.toThrow('Legacy');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
