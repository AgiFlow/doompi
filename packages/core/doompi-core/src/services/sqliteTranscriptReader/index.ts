import fs from 'node:fs/promises';
import path from 'node:path';

import type { Context } from '@earendil-works/chord';
import { branchTip, value } from '@earendil-works/pi-agent-core/harness/session';
import {
  SqliteSessionRepo,
  SqliteStorage,
  createNodeSqliteFactory,
} from '@earendil-works/pi-session-backend-sqlite-node';

import type { TranscriptPageRequest, TranscriptPage } from '../../exports/sessionProtocol';
import { readSavedExecution } from '../sqliteSessionHistory';
import { readTranscriptPage } from '../transcriptPages';

export interface SqliteTranscriptOwnership {
  sessionId: string;
  workspaceRoot: string;
  workspaceId?: string;
  groupingRoot?: string;
}

/** A completed child is read through a separate read-only WAL connection, never a second writer. */
export async function readSqliteTranscript(
  file: string,
  request: TranscriptPageRequest,
  context: Context,
  ownership?: SqliteTranscriptOwnership,
): Promise<TranscriptPage> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('Child SQLite session not found');
  } catch {
    throw new Error('Child SQLite session not found');
  }
  const factory = createNodeSqliteFactory();
  const repository = new SqliteSessionRepo({
    directory: path.dirname(file),
    databasePath: file,
    databaseFactory: factory,
  });
  let sessions: Awaited<ReturnType<typeof repository.list>>;
  try {
    sessions = await repository.list(undefined, context);
  } finally {
    await repository.close(context);
  }
  if (sessions.length !== 1) throw new Error('Child SQLite session not found');
  if (ownership !== undefined && sessions[0]!.id !== ownership.sessionId)
    throw new Error('Saved transcript does not belong to this session');
  const database = await factory.openReadOnly(file);
  const storage = new SqliteStorage(database, { sessionId: sessions[0]!.id });
  try {
    if (ownership !== undefined) {
      const owner = await storage.getValue(value('doompi.session', 'workspaceRoot'), context);
      if (owner?.value !== ownership.workspaceRoot)
        throw new Error('Saved transcript does not belong to this workspace');
      const contextValue = await storage.getValue(value('doompi.session', 'execution'), context);
      if (contextValue?.value !== undefined) {
        const execution = readSavedExecution(contextValue.value, ownership.workspaceRoot);
        if (
          !execution ||
          (ownership.workspaceId !== undefined && execution.workspaceId !== ownership.workspaceId) ||
          (ownership.groupingRoot !== undefined && execution.groupingRoot !== ownership.groupingRoot)
        )
          throw new Error('Saved transcript does not belong to this workspace');
      }
    }
    const branches = await storage.scanValues(branchTip(''), context);
    const branch =
      branches.find((item) => item.address.key === 'main') ?? (branches.length === 1 ? branches[0] : undefined);
    if (!branch && branches.length > 1) throw new Error('Child transcript has no unambiguous active lane');
    const tip = branch?.value ?? null;
    const page = await readTranscriptPage(
      {
        sessionId: sessions[0]!.id,
        laneName: branch?.address.key ?? 'main',
        lane: {
          getTipId: async () => tip,
          findEntries: (query, readContext) =>
            tip ? storage.scanBranch({ ...query, start: query?.start ?? tip }, readContext) : Promise.resolve([]),
        },
      },
      request,
      0,
      context,
    );
    return { ...page, revision: 0, drafts: [] };
  } finally {
    await storage.close(context);
    database.close();
  }
}
