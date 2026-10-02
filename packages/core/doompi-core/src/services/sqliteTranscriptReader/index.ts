import path from 'node:path';

import type { Context } from '@earendil-works/chord';
import { createSession, type Cursor, type EntryRecord } from '@earendil-works/pi-durable';

import type { TranscriptPageRequest, TranscriptPage } from '../../exports/sessionProtocol';
import { DurableNavigationDoc } from '../durableNavigation';
import { readSavedExecution } from '../sqliteSessionHistory';
import {
  DURABLE_DIRECTORY,
  SessionIdentityDoc,
  SessionMetadataDoc,
  openReadOnlyDurableStorage,
} from '../sqliteSessionStorage';
import { projectDurableEntries, readTranscriptPage } from '../transcriptPages';

export interface SqliteTranscriptOwnership {
  sessionId: string;
  workspaceRoot: string;
  workspaceId?: string;
  groupingRoot?: string;
}

/** A completed child is read without admitting a writer or updating the schema. */
export async function readSqliteTranscript(
  file: string,
  request: TranscriptPageRequest,
  context: Context,
  ownership?: SqliteTranscriptOwnership,
): Promise<TranscriptPage> {
  if (path.basename(path.dirname(file)) !== DURABLE_DIRECTORY)
    throw new Error('Legacy SQLite transcripts are unsupported');
  const storage = await openReadOnlyDurableStorage(file);
  const session = createSession(storage);
  try {
    const identity = await session.snapshot(SessionIdentityDoc, context);
    if (
      !identity ||
      identity.id !== path.basename(file, '.sqlite') ||
      (ownership && identity.id !== ownership.sessionId)
    )
      throw new Error('Saved transcript does not belong to this session');
    if (ownership) {
      const metadata = await session.snapshot(SessionMetadataDoc, context);
      const execution = readSavedExecution(metadata?.execution, ownership.workspaceRoot);
      if (
        metadata?.workspaceRoot !== ownership.workspaceRoot ||
        !execution ||
        (ownership.workspaceId !== undefined && execution.workspaceId !== ownership.workspaceId) ||
        (ownership.groupingRoot !== undefined && execution.groupingRoot !== ownership.groupingRoot)
      )
        throw new Error('Saved transcript does not belong to this workspace');
    }
    const navigation = await session.snapshot(DurableNavigationDoc, context);
    const conversationId = navigation?.activeConversationId;
    const raw: EntryRecord[] = [];
    if (conversationId !== null && conversationId !== undefined) {
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanEntries({ conversationId }, 100, cursor, context);
        raw.push(...page.items);
        cursor = page.next;
      } while (cursor);
    }
    const entries = projectDurableEntries(raw.reverse());
    const tip = entries.at(-1)?.id ?? null;
    const metadata = await session.snapshot(SessionMetadataDoc, context);
    const laneName = metadata?.laneName ?? 'main';
    const page = await readTranscriptPage(
      {
        sessionId: identity.id,
        laneName,
        lane: {
          getTipId: async () => tip,
          findEntries: async (query) => {
            let rows = entries;
            if (query.start) {
              const index = rows.findIndex((entry) => entry.id === query.start);
              if (index < 0) throw new Error('Transcript references missing entry');
              rows = rows.slice(0, index + 1);
            }
            if (query.cursor)
              rows = rows.filter((entry) =>
                query.order === 'oldestFirst' ? entry.seq > query.cursor!.seq : entry.seq < query.cursor!.seq,
              );
            if (query.type) rows = rows.filter((entry) => entry.type === query.type);
            if (query.customType)
              rows = rows.filter((entry) => entry.type === 'custom' && entry.customType === query.customType);
            if (query.order !== 'oldestFirst') rows = [...rows].reverse();
            return rows.slice(0, query.limit);
          },
        },
      },
      request,
      0,
      context,
    );
    return { ...page, revision: 0, drafts: [] };
  } finally {
    await session.close(context);
  }
}
