import fs from 'node:fs';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import type { Entry } from '@earendil-works/pi-agent-core/harness/session';
import type { TranscriptPage, TranscriptPageRequest } from '../exports/sessionProtocol';
import { readTranscriptPage } from '../services/transcriptPages';

interface JsonRecord {
  [key: string]: unknown;
}

function record(value: unknown, message: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as JsonRecord;
}

/** Reads a completed v4 journal as immutable bytes. It never opens the writable JSONL repository. */
export async function readJsonlTranscript(
  file: string,
  request: Omit<TranscriptPageRequest, 'threadId'>,
): Promise<TranscriptPage> {
  const content = fs.readFileSync(file, 'utf8');
  if (!content.endsWith('\n')) throw new Error('Child JSONL transcript is incomplete');
  const lines = content.slice(0, -1).split('\n');
  const header = record(JSON.parse(lines.shift() ?? ''), 'Invalid child JSONL header');
  if (header.kind !== 'header' || header.v !== 4 || typeof header.id !== 'string')
    throw new Error('Child transcript is not a v4 JSONL journal');

  const entries = new Map<string, Entry>();
  const tips = new Map<string, string>();
  let previousSeq = 0;
  for (const [lineIndex, line] of lines.entries()) {
    let transaction: unknown;
    try {
      transaction = JSON.parse(line);
    } catch (cause) {
      throw new Error(`Invalid child JSONL transaction at line ${lineIndex + 2}`, { cause });
    }
    const writes = Array.isArray(transaction) ? transaction : [transaction];
    for (const value of writes) {
      const write = record(value, `Invalid child JSONL write at line ${lineIndex + 2}`);
      if (!Number.isSafeInteger(write.seq) || (write.seq as number) <= previousSeq)
        throw new Error(`Invalid child JSONL sequence at line ${lineIndex + 2}`);
      previousSeq = write.seq as number;
      if (write.kind === 'entry') {
        if (typeof write.id !== 'string' || (write.parentId !== null && typeof write.parentId !== 'string'))
          throw new Error(`Invalid child JSONL entry at line ${lineIndex + 2}`);
        if (entries.has(write.id)) throw new Error(`Duplicate child JSONL entry '${write.id}'`);
        entries.set(write.id, write as unknown as Entry);
      } else if (write.kind === 'value' && write.namespace === 'pi.branch.tip' && typeof write.key === 'string') {
        if (write.op === 'delete') tips.delete(write.key);
        else if (write.op === 'set' && typeof write.value === 'string') tips.set(write.key, write.value);
        else throw new Error(`Invalid child JSONL branch tip at line ${lineIndex + 2}`);
      }
    }
  }

  const laneName = tips.has('main') ? 'main' : tips.size === 1 ? [...tips.keys()][0]! : undefined;
  if (!laneName && tips.size > 1) throw new Error('Child transcript has no unambiguous active lane');
  const tip = laneName ? (tips.get(laneName) ?? null) : null;
  const branch: Entry[] = [];
  const visited = new Set<string>();
  let id = tip;
  while (id) {
    if (visited.has(id)) throw new Error('Child JSONL transcript contains a parent cycle');
    visited.add(id);
    const entry = entries.get(id);
    if (!entry) throw new Error(`Child JSONL transcript references missing entry '${id}'`);
    branch.push(entry);
    id = entry.parentId;
  }
  branch.reverse();

  const page = await readTranscriptPage(
    {
      sessionId: header.id,
      laneName: laneName ?? 'main',
      lane: {
        getTipId: async () => tip,
        findEntries: async (query = {}) => {
          let rows = branch;
          const startIndex = query.start ? rows.findIndex((entry) => entry.id === query.start) : rows.length - 1;
          if (startIndex >= 0) rows = rows.slice(0, startIndex + 1);
          const cursor = query.cursor;
          if (cursor)
            rows = rows.filter((entry) =>
              query.order === 'oldestFirst' ? entry.seq > cursor.seq : entry.seq < cursor.seq,
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
    BACKGROUND_CONTEXT,
  );
  return { ...page, revision: 0, drafts: [] };
}
