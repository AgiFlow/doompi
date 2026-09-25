import fs from 'node:fs/promises';
import path from 'node:path';

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

/** Private execution context, never included in the HTTP history summary. */
export interface SavedSessionExecution {
  cwd: string;
  repoRoot: string;
  workspaceId: string;
  groupingRoot: string;
  parentSessionId?: string;
  sessionProvenance?: string;
  inheritedArtifact?: unknown;
}

export interface SavedSessionRecord {
  summary: SavedSession;
  execution: SavedSessionExecution;
}

function readExecution(raw: unknown, owner: string): SavedSessionExecution | undefined {
  if (typeof raw !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.cwd !== 'string' ||
    !path.isAbsolute(record.cwd) ||
    typeof record.repoRoot !== 'string' ||
    !path.isAbsolute(record.repoRoot) ||
    record.repoRoot !== owner ||
    typeof record.workspaceId !== 'string' ||
    record.workspaceId === '' ||
    typeof record.groupingRoot !== 'string' ||
    !path.isAbsolute(record.groupingRoot)
  ) return undefined;
  if (record.parentSessionId !== undefined && typeof record.parentSessionId !== 'string') return undefined;
  if (record.sessionProvenance !== undefined && typeof record.sessionProvenance !== 'string') return undefined;
  return {
    cwd: record.cwd,
    repoRoot: record.repoRoot,
    workspaceId: record.workspaceId,
    groupingRoot: record.groupingRoot,
    ...(typeof record.parentSessionId === 'string' ? { parentSessionId: record.parentSessionId } : {}),
    ...(typeof record.sessionProvenance === 'string' ? { sessionProvenance: record.sessionProvenance } : {}),
    ...(record.inheritedArtifact === undefined ? {} : { inheritedArtifact: record.inheritedArtifact }),
  };
}

/** Lists private execution records for one admitted workspace. */
export async function listSavedSessionRecords(
  sessionsRoot: string,
  workspaceRoot: string,
  activeSessionIds: ReadonlySet<string>,
  workspaceId?: string,
): Promise<SavedSessionRecord[]> {
  const factory = createNodeSqliteFactory();
  const repository = new SqliteSessionRepo({ directory: sessionsRoot, databaseFactory: factory });
  let sessions: Awaited<ReturnType<typeof repository.list>>;
  try {
    sessions = await repository.list(undefined, BACKGROUND_CONTEXT);
  } finally {
    await repository.close(BACKGROUND_CONTEXT);
  }
  const result: SavedSessionRecord[] = [];
  for (const metadata of sessions) {
    if (activeSessionIds.has(metadata.id)) continue;
    const database = await factory.openReadOnly(metadata.path);
    const storage = new SqliteStorage(database, { sessionId: metadata.id });
    try {
      const owner = await storage.getValue(value('doompi.session', 'workspaceRoot'), BACKGROUND_CONTEXT);
      if (typeof owner?.value !== 'string') continue;
      const context = await storage.getValue(value('doompi.session', 'execution'), BACKGROUND_CONTEXT);
      const execution = readExecution(context?.value, owner.value);
      if (execution) {
        if (execution.groupingRoot !== workspaceRoot || (workspaceId && execution.workspaceId !== workspaceId)) continue;
      } else {
        // Legacy journals have only an execution root. Never infer worktree grouping
        // or a subdirectory pwd from their parent workspace.
        if (owner.value !== workspaceRoot) continue;
      }
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
        summary: {
          id: metadata.id,
          ...(typeof name?.value === 'string' ? { name: name.value } : {}),
          firstMessage,
          createdAt: new Date(metadata.createdAt).toISOString(),
          updatedAt: file.mtime.toISOString(),
          messageCount: stats.messageCount,
        },
        execution: execution ?? {
          cwd: workspaceRoot,
          repoRoot: workspaceRoot,
          groupingRoot: workspaceRoot,
          workspaceId: workspaceId ?? '',
        },
      });
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
      database.close();
    }
  }
  return result.sort((left, right) => right.summary.updatedAt.localeCompare(left.summary.updatedAt));
}

/** Public history summaries contain no execution paths or pinned artifacts. */
export async function listSavedSessions(
  sessionsRoot: string,
  workspaceRoot: string,
  activeSessionIds: ReadonlySet<string>,
  workspaceId?: string,
): Promise<SavedSession[]> {
  return (await listSavedSessionRecords(sessionsRoot, workspaceRoot, activeSessionIds, workspaceId)).map(
    (record) => record.summary,
  );
}
