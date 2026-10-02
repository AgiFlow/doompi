import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, expect, it, vi } from 'vitest';

import { createHistoryOwnership } from '../../../../../src/services/historyOwnership';
import { DURABLE_BACKGROUND_CONTEXT as BACKGROUND_CONTEXT } from '../../../../../src/services/sqliteSessionStorage';
import { openSqliteSessionStorage } from '../../../../../src/services/sqliteSessionStorage';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

it('persists server entries, rejects a second writer, and reopens by session id', async () => {
  const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-sqlite-'));
  directories.push(sessionsRoot);
  const options = {
    sessionsRoot,
    sessionId: 'test',
    historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }),
  };
  const first = await openSqliteSessionStorage(options, BACKGROUND_CONTEXT);
  try {
    await first.session.commit(async (tx) => {
      const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
      await tx.appendEntry(conversation.id, {
        kind: 'user',
        model: [{ role: 'user', content: 'durable', timestamp: 100 }],
      });
    }, BACKGROUND_CONTEXT);
    await expect(openSqliteSessionStorage(options, BACKGROUND_CONTEXT)).rejects.toThrow('lock');
  } finally {
    await first.session.close(BACKGROUND_CONTEXT);
    await first.repository.close(BACKGROUND_CONTEXT);
    await first.historyLease.release();
  }
  const second = await openSqliteSessionStorage(options, BACKGROUND_CONTEXT);
  try {
    const conversations = await second.storage.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT);
    const entries = (
      await second.storage.scanEntries(
        { conversationId: conversations.items[0]!.id },
        10,
        undefined,
        BACKGROUND_CONTEXT,
      )
    ).items;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'user', model: [{ content: 'durable' }] });
    const header = await fs.readFile(second.sessionFile);
    expect(header.subarray(0, 16).toString()).toBe('SQLite format 3\u0000');
  } finally {
    await second.session.close(BACKGROUND_CONTEXT);
    await second.repository.close(BACKGROUND_CONTEXT);
    await second.historyLease.release();
  }
});

it('reopens durable SQLite history after its previous process left a valid dead-owner sidecar', async () => {
  const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-sqlite-recovery-'));
  directories.push(sessionsRoot);
  const options = {
    sessionsRoot,
    sessionId: 'recovery',
    historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }),
  };
  const first = await openSqliteSessionStorage(options, BACKGROUND_CONTEXT);
  await first.session.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
    await tx.appendEntry(conversation.id, {
      kind: 'user',
      model: [{ role: 'user', content: 'keep this', timestamp: 100 }],
    });
  }, BACKGROUND_CONTEXT);
  await first.session.close(BACKGROUND_CONTEXT);
  await first.repository.close(BACKGROUND_CONTEXT);
  await first.historyLease.release();

  const lockPath = `${first.sessionFile}.doompi-v4.lock`;
  await fs.writeFile(
    lockPath,
    JSON.stringify({
      version: 1,
      format: 'doompi-v4-history-ownership',
      pid: 99999999,
      sourcePath: await fs.realpath(first.sessionFile),
      token: '0cc2f679-c8a9-4b5f-8137-d50372c0b623',
    }),
  );
  const realKill = process.kill.bind(process);
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === 99999999) throw Object.assign(new Error('owner exited'), { code: 'ESRCH' });
    return realKill(pid, signal);
  });
  const second = await openSqliteSessionStorage(options, BACKGROUND_CONTEXT);
  try {
    const conversations = await second.storage.scanConversations({}, 10, undefined, BACKGROUND_CONTEXT);
    const entries = (
      await second.storage.scanEntries(
        { conversationId: conversations.items[0]!.id },
        10,
        undefined,
        BACKGROUND_CONTEXT,
      )
    ).items;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'user', model: [{ content: 'keep this' }] });
  } finally {
    await second.session.close(BACKGROUND_CONTEXT);
    await second.repository.close(BACKGROUND_CONTEXT);
    await second.historyLease.release();
  }
  await expect(fs.access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects legacy files without modifying them or creating a fresh replacement', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-legacy-'));
  directories.push(root);
  const legacy = path.join(root, 'old.sqlite');
  await fs.writeFile(legacy, 'legacy bytes');
  const options = {
    sessionsRoot: root,
    sessionId: 'old',
    historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }),
  };
  await expect(openSqliteSessionStorage(options, BACKGROUND_CONTEXT)).rejects.toThrow('Legacy');
  expect(await fs.readFile(legacy, 'utf8')).toBe('legacy bytes');
  await expect(fs.access(path.join(root, 'durable-v1', 'old.sqlite'))).rejects.toThrow();
  await fs.mkdir(path.join(root, 'durable-v1'));
  const freshPath = path.join(root, 'durable-v1', 'old.sqlite');
  await fs.writeFile(freshPath, 'not durable');
  await expect(openSqliteSessionStorage(options, BACKGROUND_CONTEXT)).rejects.toThrow();
  expect(await fs.readFile(freshPath, 'utf8')).toBe('not durable');
  await expect(fs.access(`${freshPath}.doompi-v4.lock`)).rejects.toThrow();
});

it('rejects a real legacy SQLite schema before opening a writable connection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-legacy-sqlite-'));
  directories.push(root);
  await fs.mkdir(path.join(root, 'durable-v1'));
  const file = path.join(root, 'durable-v1', 'old.sqlite');
  const database = new DatabaseSync(file);
  database.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY); INSERT INTO sessions VALUES ('old')");
  database.close();
  const before = await fs.readFile(file);
  await expect(
    openSqliteSessionStorage(
      { sessionsRoot: root, sessionId: 'old', historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }) },
      BACKGROUND_CONTEXT,
    ),
  ).rejects.toThrow('legacy');
  expect(await fs.readFile(file)).toEqual(before);
  expect(await fs.readdir(path.dirname(file))).toEqual(['old.sqlite']);
});
