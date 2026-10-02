import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Context } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createSession, defineDoc, type Storage } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { NodeSqliteDatabase, openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';

import type { DirectHarnessRuntimeOptions } from '../../types/server/directHarnessRuntime';

export const DURABLE_BACKGROUND_CONTEXT = BACKGROUND_CONTEXT;

export const DURABLE_DIRECTORY = 'durable-v1';
/** Public string identity belongs to Doom, not the durable numeric ID namespace. */
export const SessionIdentityDoc = defineDoc({
  kind: 'doompi.session.identity',
  version: 1,
  scope: 'session',
  initial: () => ({ id: '', createdAt: 0, parentSessionId: '' }),
});
export const SessionMetadataDoc = defineDoc({
  kind: 'doompi.session.metadata',
  version: 1,
  scope: 'session',
  initial: () => ({ name: '', workspaceRoot: '', execution: '', laneName: 'main' }),
});

/** Validate existing files without admitting a writer or applying schema upgrades. */
export function validateDurableSessionFile(file: string): void {
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const schema = database.prepare('SELECT version FROM durable_schema WHERE singleton = 1').get();
    if (schema?.version !== 1) throw new Error('Unsupported durable SQLite schema');
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    for (const name of [
      'durable_metadata',
      'record_ids',
      'conversations',
      'entries',
      'tasks',
      'submissions',
      'documents',
      'document_revisions',
    ]) {
      if (!tables.some((table) => table.name === name)) throw new Error('Invalid durable SQLite schema');
    }
  } catch (cause) {
    throw new Error('Unsupported or legacy SQLite session format', { cause });
  } finally {
    database.close();
  }
}

/** Completed histories use a read-only connection. Initialization cannot write or migrate. */
export async function openReadOnlyDurableStorage(file: string): Promise<Storage> {
  validateDurableSessionFile(file);
  const native = new DatabaseSync(file, { readOnly: true });
  const database = new NodeSqliteDatabase(native);
  let closed = false;
  const close = async () => {
    if (closed) return;
    // The writer adapter checkpoints WAL on close, which read-only connections cannot do.
    native.close();
    closed = true;
  };
  try {
    const storage = await SqliteStorage.open({
      exec: (sql) => database.exec(sql),
      run: (sql, ...params) => database.run(sql, ...params),
      get: (sql, ...params) => database.get(sql, ...params),
      all: (sql, ...params) => database.all(sql, ...params),
      close,
      transaction: (callback) =>
        callback({
          exec: async (sql) => {
            if (!/^CREATE TABLE IF NOT EXISTS durable_schema\s/u.test(sql))
              throw new Error('Read-only durable storage');
          },
          run: async (sql) => {
            if (sql !== 'INSERT OR IGNORE INTO durable_schema (singleton, version) VALUES (1, 0)')
              throw new Error('Read-only durable storage');
          },
          get: (sql, ...params) => database.get(sql, ...params),
          all: (sql, ...params) => database.all(sql, ...params),
        }),
    });
    return storage;
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Read-only storage initialization cleanup failed');
    }
    throw error;
  }
}

/** Opens the one fresh-format SQLite container owned by a server session. */
export async function openSqliteSessionStorage(
  options: Pick<
    DirectHarnessRuntimeOptions,
    'historyOwnership' | 'sessionsRoot' | 'sessionPath' | 'sessionId' | 'parentSessionId'
  >,
  context: Context,
) {
  if (!options.historyOwnership) throw new Error('SQLite sessions require explicit HistoryOwnership');
  if (!options.sessionsRoot && !options.sessionPath) throw new Error('SQLite sessions require a server data directory');
  const id = options.sessionId ?? (options.sessionPath ? path.basename(options.sessionPath, '.sqlite') : randomUUID());
  if (!/^[a-zA-Z0-9_-]+$/u.test(id)) throw new Error('Invalid SQLite session id');
  const sessionFile = path.resolve(
    options.sessionPath ?? path.join(options.sessionsRoot!, DURABLE_DIRECTORY, `${id}.sqlite`),
  );
  if (path.basename(path.dirname(sessionFile)) !== DURABLE_DIRECTORY || path.extname(sessionFile) !== '.sqlite')
    throw new Error('Unsupported or legacy SQLite session path');
  const existing = fs.existsSync(sessionFile);
  if (!existing && options.sessionsRoot && fs.existsSync(path.join(options.sessionsRoot, `${id}.sqlite`)))
    throw new Error('Legacy SQLite sessions are unsupported by fresh durable storage');
  if (options.sessionPath && !existing) throw new Error(`SQLite session not found: ${sessionFile}`);
  if (existing) validateDurableSessionFile(sessionFile);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
  const historyLease = await options.historyOwnership.acquire(sessionFile);
  let storage: Storage | undefined;
  let database: NodeSqliteDatabase | undefined;
  let writerOpenAttempted = false;
  try {
    await historyLease.assertQuiescent();
    if (fs.existsSync(sessionFile)) validateDurableSessionFile(sessionFile);
    writerOpenAttempted = true;
    database = await openNodeSqliteDatabase(sessionFile);
    storage = await SqliteStorage.open(database);
    const session = createSession(storage);
    const identity = await session.snapshot(SessionIdentityDoc, context);
    if (existing && (!identity || identity.id !== id))
      throw new Error('SQLite session id does not match the requested session');
    if (!existing) {
      await session.commit(async (tx) => {
        const doc = await tx.doc(SessionIdentityDoc);
        doc.id = id;
        doc.createdAt = Date.now();
        doc.parentSessionId = options.parentSessionId ?? '';
      }, context);
      fs.chmodSync(sessionFile, 0o600);
    }
    const repository = { close: (closeContext: Context = context) => session.close(closeContext) };
    return { storage, session, sessionFile, repository, historyLease };
  } catch (error) {
    // ponytail: An upstream open rejection has no closure receipt, so retain ownership until shutdown is confirmed.
    if (writerOpenAttempted && !database) throw error;
    try {
      if (storage) await storage.close(context);
      else if (database) await database.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'SQLite storage initialization cleanup failed');
    }
    try {
      await historyLease.release();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'SQLite storage ownership cleanup failed');
    }
    throw error;
  }
}
