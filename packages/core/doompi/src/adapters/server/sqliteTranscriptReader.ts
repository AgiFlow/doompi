import path from 'node:path';
import {
  SqliteSessionRepo,
  SqliteStorage,
  createNodeSqliteFactory,
} from '@earendil-works/pi-session-backend-sqlite-node';
import { branchTip } from '@earendil-works/pi-agent-core/harness/session';
import type { Context } from '@earendil-works/chord';
import type { TranscriptPageRequest, TranscriptPage } from '@agimon-ai/doompi-extension-contracts/session-protocol';
import { readTranscriptPage } from './transcriptPages.ts';

/** A completed child is read through a separate read-only WAL connection, never a second writer. */
export async function readSqliteTranscript(
  file: string,
  request: TranscriptPageRequest,
  context: Context,
): Promise<TranscriptPage> {
  const factory = createNodeSqliteFactory();
  const repository = new SqliteSessionRepo({
    directory: path.dirname(file),
    databasePath: file,
    databaseFactory: factory,
  });
  const sessions = await repository.list(undefined, context);
  await repository.close(context);
  if (sessions.length !== 1) throw new Error('Child SQLite session not found');
  const database = await factory.openReadOnly(file);
  const storage = new SqliteStorage(database, { sessionId: sessions[0]!.id });
  try {
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
