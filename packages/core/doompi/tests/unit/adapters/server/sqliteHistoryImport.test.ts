import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { HistoryImportCommand } from '../../../../src/commands/historyImportCommand.ts';
import { openSqliteSessionStorage } from '../../../../src/adapters/server/sqliteSessionStorage.ts';
import { createHistoryOwnership } from '../../../../src/adapters/serialization/historyOwnership.ts';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';

it('imports v4 history without modifying the source and verifies a repeated offline import', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-sqlite-import-'));
  try {
    const source = path.join(directory, 'source.jsonl');
    const destination = path.join(directory, 'history.sqlite');
    const original =
      [
        { v: 4, kind: 'header', id: 'imported', createdAt: 100, storageVersion: 1, cwd: directory },
        [
          {
            kind: 'entry',
            seq: 1,
            timestamp: 110,
            type: 'message',
            id: 'one',
            parentId: null,
            message: { role: 'user', content: 'preserved', timestamp: 110 },
          },
          { kind: 'value', seq: 2, op: 'set', namespace: 'pi.branch.tip', key: 'main', value: 'one' },
        ],
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n';
    await fs.writeFile(source, original);
    const command = new HistoryImportCommand();
    const output: string[] = [];
    const args = ['history-import', source, destination, '--format', 'sqlite', '--confirm-offline'];
    await command.execute(args, process.env, directory, {
      write: (text) => {
        output.push(text);
      },
    });
    await command.execute(args, process.env, directory, {
      write: (text) => {
        output.push(text);
      },
    });
    expect(JSON.parse(output[1]!).status).toBe('already-published');
    expect(await fs.readFile(source, 'utf8')).toBe(original);
    const storage = await openSqliteSessionStorage(
      { sessionPath: destination, historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }) },
      BACKGROUND_CONTEXT,
    );
    try {
      expect(await storage.session.getEntry('one', BACKGROUND_CONTEXT)).toMatchObject({
        id: 'one',
        timestamp: 110,
        message: { content: 'preserved' },
      });
      expect(await (await storage.session.branch('main', BACKGROUND_CONTEXT))?.getTipId(BACKGROUND_CONTEXT)).toBe(
        'one',
      );
    } finally {
      await storage.session.close(BACKGROUND_CONTEXT);
      await storage.repository.close(BACKGROUND_CONTEXT);
      await storage.historyLease.release();
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('normalizes v3 through Pi before publishing the SQLite destination', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doompi-sqlite-v3-'));
  try {
    const source = path.join(directory, 'legacy.jsonl');
    const destination = path.join(directory, 'canonical.sqlite');
    const original =
      [
        { type: 'session', version: 3, id: 'legacy-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: directory },
        {
          type: 'message',
          id: 'root',
          parentId: null,
          timestamp: '2026-01-01T00:00:01.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        },
        {
          type: 'message',
          id: 'child',
          parentId: 'root',
          timestamp: '2026-01-01T00:00:02.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'world' }] },
        },
      ]
        .map((item) => JSON.stringify(item))
        .join('\n') + '\n';
    await fs.writeFile(source, original);
    const output: string[] = [];
    await new HistoryImportCommand().execute(
      ['history-import', source, destination, '--format', 'sqlite', '--confirm-offline'],
      process.env,
      directory,
      { write: (text) => output.push(text) },
    );
    expect(JSON.parse(output[0]!).entryCount).toBe(2);
    expect(await fs.readFile(source, 'utf8')).toBe(original);
    const storage = await openSqliteSessionStorage(
      { sessionPath: destination, historyOwnership: createHistoryOwnership({ sourceFormat: 'sqlite' }) },
      BACKGROUND_CONTEXT,
    );
    try {
      const entries = await storage.session.findEntries({ order: 'asc' }, BACKGROUND_CONTEXT);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ parentId: null, message: { role: 'user' } });
      expect(entries[1]).toMatchObject({ parentId: entries[0]!.id, message: { role: 'assistant' } });
    } finally {
      await storage.session.close(BACKGROUND_CONTEXT);
      await storage.repository.close(BACKGROUND_CONTEXT);
      await storage.historyLease.release();
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
