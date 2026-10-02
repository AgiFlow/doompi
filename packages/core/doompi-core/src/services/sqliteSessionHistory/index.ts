import fs from 'node:fs/promises';
import path from 'node:path';

import { createSession, type Cursor, type EntryRecord } from '@earendil-works/pi-durable';

import {
  DURABLE_DIRECTORY,
  DURABLE_BACKGROUND_CONTEXT as context,
  SessionIdentityDoc,
  SessionMetadataDoc,
  openReadOnlyDurableStorage,
} from '../sqliteSessionStorage';

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

export function readSavedExecution(raw: unknown, owner: string): SavedSessionExecution | undefined {
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
  )
    return undefined;
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

/** Lists only fresh durable containers, never legacy journals. */
export async function listSavedSessionRecords(
  sessionsRoot: string,
  workspaceRoot: string,
  activeSessionIds: ReadonlySet<string>,
  workspaceId?: string,
): Promise<SavedSessionRecord[]> {
  const directory = path.join(sessionsRoot, DURABLE_DIRECTORY);
  const files = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const result: SavedSessionRecord[] = [];
  for (const file of files) {
    if (!/^[a-zA-Z0-9_-]+\.sqlite$/u.test(file)) continue;
    const id = path.basename(file, '.sqlite');
    if (activeSessionIds.has(id)) continue;
    const filePath = path.join(directory, file);
    const storage = await openReadOnlyDurableStorage(filePath);
    const session = createSession(storage);
    try {
      const identity = await session.snapshot(SessionIdentityDoc, context);
      if (!identity || identity.id !== id) throw new Error('Durable session identity mismatch');
      const metadata = await session.snapshot(SessionMetadataDoc, context);
      if (!metadata?.workspaceRoot) continue;
      const execution = readSavedExecution(metadata.execution, metadata.workspaceRoot);
      if (
        !execution ||
        execution.groupingRoot !== workspaceRoot ||
        (workspaceId && execution.workspaceId !== workspaceId)
      )
        continue;
      const entries = new Map<number, EntryRecord>();
      let conversationCursor: Cursor | undefined;
      do {
        const conversations = await storage.scanConversations({}, 100, conversationCursor, context);
        for (const conversation of conversations.items) {
          let cursor: Cursor | undefined;
          do {
            const page = await storage.scanEntries({ conversationId: conversation.id }, 100, cursor, context);
            for (const entry of page.items) entries.set(entry.id, entry);
            cursor = page.next;
          } while (cursor);
        }
        conversationCursor = conversations.next;
      } while (conversationCursor);
      const ordered = [...entries.values()].sort((a, b) => a.id - b.id);
      const messages = ordered.flatMap((entry) => entry.model ?? []);
      const content = messages.find((message) => message.role === 'user')?.content;
      const firstMessage =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n')
            : '';
      const stat = await fs.stat(filePath);
      result.push({
        summary: {
          id,
          ...(metadata.name ? { name: metadata.name } : {}),
          firstMessage,
          createdAt: new Date(identity.createdAt).toISOString(),
          updatedAt: stat.mtime.toISOString(),
          messageCount: messages.length,
        },
        execution,
      });
    } finally {
      await session.close(context);
    }
  }
  return result.sort((a, b) => b.summary.updatedAt.localeCompare(a.summary.updatedAt));
}

/** Public summaries do not expose private execution metadata. */
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
