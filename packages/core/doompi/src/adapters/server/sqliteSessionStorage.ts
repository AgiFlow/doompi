import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SqliteSessionRepo, createNodeSqliteFactory } from '@earendil-works/pi-session-backend-sqlite-node';
import type { Context } from '@earendil-works/pi-agent-core/harness/context';
import type { DirectHarnessRuntimeOptions, SqliteSessionStorage } from '../../types/server/directHarnessRuntime.ts';

/** Opens the one SQLite container owned by a server session. */
export async function openSqliteSessionStorage(
  options: Pick<
    DirectHarnessRuntimeOptions,
    'historyOwnership' | 'sessionsRoot' | 'sessionPath' | 'sessionId' | 'parentSessionId'
  >,
  context: Context,
): Promise<SqliteSessionStorage> {
  if (!options.historyOwnership) throw new Error('SQLite sessions require explicit HistoryOwnership');
  if (!options.sessionsRoot && !options.sessionPath) throw new Error('SQLite sessions require a server data directory');
  const id = options.sessionId ?? randomUUID();
  if (!/^[a-zA-Z0-9_-]+$/u.test(id)) throw new Error('Invalid SQLite session id');
  const sessionFile = path.resolve(options.sessionPath ?? path.join(options.sessionsRoot!, `${id}.sqlite`));
  const historyLease = await options.historyOwnership.acquire(sessionFile);
  const repository = new SqliteSessionRepo({
    directory: path.dirname(sessionFile),
    databasePath: sessionFile,
    databaseFactory: createNodeSqliteFactory(),
  });
  try {
    await historyLease.assertQuiescent();
    const existing = fs.existsSync(sessionFile);
    if (options.sessionPath && !existing) throw new Error(`SQLite session not found: ${sessionFile}`);
    const metadata = existing ? await repository.list(undefined, context) : [];
    if (existing && metadata.length !== 1) throw new Error('Expected exactly one session in the SQLite container');
    if (existing && options.sessionId && metadata[0]!.id !== options.sessionId)
      throw new Error('SQLite session id does not match the requested session');
    const session = existing
      ? await repository.open(metadata[0]!, context)
      : await repository.create(
          { id, ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}) },
          context,
        );
    if (!existing) fs.chmodSync(sessionFile, 0o600);
    return { session, sessionFile, repository, historyLease };
  } catch (error) {
    try {
      await repository.close(context);
    } finally {
      await historyLease.release();
    }
    throw error;
  }
}
