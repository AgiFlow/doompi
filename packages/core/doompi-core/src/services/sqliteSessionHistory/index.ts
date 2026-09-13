import fs from 'node:fs/promises';

import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { sessionName, value } from '@earendil-works/pi-agent-core/harness/session';
import {
  SqliteSessionRepo,
  SqliteStorage,
  createNodeSqliteFactory,
} from '@earendil-works/pi-session-backend-sqlite-node';

export interface SavedSession {
  id: string;
  name?: string;
  firstMessage: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** Lists inactive journals belonging to one admitted workspace. */
export async function listSavedSessions(
  sessionsRoot: string,
  workspaceRoot: string,
  activeSessionIds: ReadonlySet<string>,
): Promise<SavedSession[]> {
  const factory = createNodeSqliteFactory();
  const repository = new SqliteSessionRepo({ directory: sessionsRoot, databaseFactory: factory });
  let sessions: Awaited<ReturnType<typeof repository.list>>;
  try {
    sessions = await repository.list(undefined, BACKGROUND_CONTEXT);
  } finally {
    await repository.close(BACKGROUND_CONTEXT);
  }
  const result: SavedSession[] = [];
  for (const metadata of sessions) {
    if (activeSessionIds.has(metadata.id)) continue;
    const database = await factory.openReadOnly(metadata.path);
    const storage = new SqliteStorage(database, { sessionId: metadata.id });
    try {
      const owner = await storage.getValue(value('doompi.session', 'workspaceRoot'), BACKGROUND_CONTEXT);
      if (owner?.value !== workspaceRoot) continue;
      const [name, entries, stats, file] = await Promise.all([
        storage.getValue(sessionName, BACKGROUND_CONTEXT),
        storage.scanEntries({ type: 'message', order: 'asc', limit: 100 }, BACKGROUND_CONTEXT),
        storage.getStats(BACKGROUND_CONTEXT),
        fs.stat(metadata.path),
      ]);
      const firstUser = entries.find((entry) => entry.type === 'message' && entry.message.role === 'user');
      const content =
        firstUser?.type === 'message' && 'content' in firstUser.message ? firstUser.message.content : undefined;
      const firstMessage =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n')
            : '';
      result.push({
        id: metadata.id,
        ...(typeof name?.value === 'string' ? { name: name.value } : {}),
        firstMessage,
        createdAt: new Date(metadata.createdAt).toISOString(),
        updatedAt: file.mtime.toISOString(),
        messageCount: stats.messageCount,
      });
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
      database.close();
    }
  }
  return result.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
