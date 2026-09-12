import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { branchTip, value, type Write } from '@earendil-works/pi-agent-core/harness/session';
import {
  SqliteSessionRepo,
  SqliteStorage,
  createNodeSqliteFactory,
} from '@earendil-works/pi-session-backend-sqlite-node';
import { contentHash, importV3WithPinnedUpstream } from '../jsonlSessionRepo';
import type { HistoryImportVerification, HistoryStagingImportInput } from '../historyImport';

type RecordValue = Record<string, unknown>;

function record(input: unknown): RecordValue {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid history record');
  return input as RecordValue;
}

/** Replays a protected, offline journal through Pi's public SQLite session writer. */
export async function importSqliteHistory(input: HistoryStagingImportInput): Promise<HistoryImportVerification> {
  let content = fs.readFileSync(input.stagingPath, 'utf8');
  const sourceHeader = record(JSON.parse(content.split('\n', 1)[0]!));
  let verification: HistoryImportVerification | undefined;
  if (sourceHeader.type === 'session' && sourceHeader.version === 3) {
    verification = await importV3WithPinnedUpstream(input);
    content = fs.readFileSync(input.stagingPath, 'utf8');
  }
  if (!content.endsWith('\n')) throw new Error('Cannot import truncated history');
  const lines = content.trimEnd().split('\n');
  const header = record(JSON.parse(lines.shift()!));
  if (header.kind !== 'header' || header.v !== 4 || typeof header.id !== 'string')
    throw new Error('Expected v3 or v4 history');
  const transactions = lines.map((line) => {
    const parsed: unknown = JSON.parse(line);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(record);
  });
  const entries = transactions.flat().filter((item) => item.kind === 'entry');
  const values = new Map<string, RecordValue>();
  for (const item of transactions.flat())
    if (item.kind === 'value') {
      const key = JSON.stringify([item.namespace, item.key]);
      if (item.op === 'delete') values.delete(key);
      else values.set(key, item);
    }
  for (const item of values.values())
    if (item.namespace === 'pi.lane.state') {
      const state = record(item.value);
      if (state.currentOperationId != null || (Array.isArray(state.inbox) && state.inbox.length > 0))
        throw new Error('SQLite import requires settled sessions with empty queues');
    }
  verification ??= {
    entries: entries.map((entry) => ({
      sourceId: String(entry.id),
      importedId: String(entry.id),
      sourceParentId: entry.parentId as string | null,
      importedParentId: entry.parentId as string | null,
      sourceContentHash: contentHash(entry),
      importedContentHash: contentHash(entry),
    })),
    branches: [...values.values()]
      .filter((item) => item.namespace === 'pi.branch.tip')
      .map((item) => ({
        branch: String(item.key),
        sourceTipId: item.value as string | null,
        importedTipId: item.value as string | null,
      })),
  };
  fs.unlinkSync(input.stagingPath);
  let timestamp = Number(header.createdAt);
  if (!Number.isFinite(timestamp)) throw new Error('Invalid history creation timestamp');
  const repository = new SqliteSessionRepo({
    directory: path.dirname(input.stagingPath),
    databasePath: input.stagingPath,
    databaseFactory: createNodeSqliteFactory(),
    now: () => timestamp,
  });
  try {
    const session = await repository.create(
      {
        id: header.id,
        ...(typeof header.parentSessionId === 'string' ? { parentSessionId: header.parentSessionId } : {}),
      },
      BACKGROUND_CONTEXT,
    );
    for (const transaction of transactions) {
      const entryTime = transaction.find((item) => item.kind === 'entry')?.timestamp;
      if (typeof entryTime === 'number') timestamp = entryTime;
      const writes = transaction.map((item): Write => {
        const { kind, seq: _seq, timestamp: _timestamp, ...rest } = item;
        if (kind === 'entry') return { kind, entry: rest } as unknown as Write;
        if (kind === 'usage') return { kind, row: { ...rest, timestamp: item.timestamp } } as unknown as Write;
        if (kind === 'value' || kind === 'list') return { kind, ...rest } as unknown as Write;
        throw new Error(`Unsupported history record kind: ${String(kind)}`);
      });
      await session.mutate(
        (mutation, context) => mutation.commit(writes, context).then(() => undefined),
        BACKGROUND_CONTEXT,
      );
    }
    for (const item of values.values()) {
      const stored = await session.getValue(value(String(item.namespace), String(item.key)), BACKGROUND_CONTEXT);
      if (JSON.stringify(stored?.value) !== JSON.stringify(item.value))
        throw new Error('Imported session state differs from the source');
    }
    const copied = await session.findEntries({ order: 'asc' }, BACKGROUND_CONTEXT);
    if (
      copied.length !== entries.length ||
      copied.some((entry, index) => entry.id !== entries[index]?.id || entry.timestamp !== entries[index]?.timestamp)
    )
      throw new Error('Imported entry identity or timestamp differs from the source');
    await session.close(BACKGROUND_CONTEXT);
  } finally {
    await repository.close(BACKGROUND_CONTEXT);
  }
  const database = new DatabaseSync(input.stagingPath);
  try {
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    database.close();
  }
  fs.chmodSync(input.stagingPath, 0o600);
  return verifySqliteHistory(input.stagingPath, verification);
}

/** Reopens the staged database read-only before protected publication. */
export async function verifySqliteHistory(
  stagingPath: string,
  proof: HistoryImportVerification,
): Promise<HistoryImportVerification> {
  const factory = createNodeSqliteFactory();
  const repository = new SqliteSessionRepo({
    directory: path.dirname(stagingPath),
    databasePath: stagingPath,
    databaseFactory: factory,
  });
  const sessions = await repository.list(undefined, BACKGROUND_CONTEXT);
  await repository.close(BACKGROUND_CONTEXT);
  if (sessions.length !== 1) throw new Error('Invalid imported SQLite session');
  const database = await factory.openReadOnly(stagingPath);
  const storage = new SqliteStorage(database, { sessionId: sessions[0]!.id });
  try {
    const entries = await storage.scanEntries({}, BACKGROUND_CONTEXT);
    if (entries.length !== proof.entries.length) throw new Error('SQLite import entry count differs');
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    for (const expected of proof.entries) {
      const entry = byId.get(expected.importedId);
      if (
        !entry ||
        entry.parentId !== expected.importedParentId ||
        contentHash(entry as unknown as RecordValue) !== expected.importedContentHash
      )
        throw new Error(`SQLite import verification failed for ${expected.importedId}`);
    }
    for (const branch of proof.branches)
      if (branch.branch !== undefined) {
        const tip = await storage.getValue(branchTip(branch.branch), BACKGROUND_CONTEXT);
        if (tip?.value !== branch.importedTipId) throw new Error('SQLite import branch differs');
      }
    return proof;
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
    database.close();
  }
}
