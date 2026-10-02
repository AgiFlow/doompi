import type { Context } from '@earendil-works/chord';

import type { JsonValue, TranscriptPage, TranscriptPageRequest } from '../../exports/sessionProtocol';
import type { DirectHarnessRuntime, Entry } from '../../types/server/directHarnessRuntime';

const PAGE_SIZE = 100;

export interface TranscriptEntryQuery {
  start?: string;
  order?: 'oldestFirst' | 'newestFirst';
  limit?: number;
  cursor?: { seq: number };
  type?: Entry['type'];
  customType?: string;
}
export interface TranscriptLane {
  getTipId(context: Context): Promise<string | null>;
  findEntries(query: TranscriptEntryQuery, context: Context): Promise<Entry[]>;
}

export function transcriptCursor(sessionId: string, lane: string, generation: number, seq: number): string {
  return Buffer.from(JSON.stringify([sessionId, lane, generation, seq])).toString('base64url');
}

/** Branch-relative keyset reads never materialize the complete conversation. */
export async function readTranscriptPage(
  runtime: Pick<DirectHarnessRuntime, 'sessionId' | 'laneName'> & {
    lane: TranscriptLane;
  },
  request: TranscriptPageRequest,
  generation: number,
  context: Context,
): Promise<Omit<TranscriptPage, 'revision' | 'drafts'>> {
  const limit = request.limit ?? PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE)
    throw new Error('Transcript page limit must be between 1 and 100');
  const newer = request.direction === 'newer';
  if (request.direction !== undefined && !['older', 'newer'].includes(request.direction))
    throw new Error('Invalid transcript direction');
  let seq: number | undefined;
  if (request.cursor !== undefined) {
    if (typeof request.cursor !== 'string' || request.cursor.length > 1024)
      throw new Error('Invalid transcript cursor');
    let cursor: unknown;
    try {
      cursor = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8'));
    } catch {
      throw new Error('Invalid transcript cursor');
    }
    if (
      !Array.isArray(cursor) ||
      cursor.length !== 4 ||
      cursor[0] !== runtime.sessionId ||
      cursor[1] !== runtime.laneName ||
      !Number.isSafeInteger(cursor[3]) ||
      cursor[3] < 0
    )
      throw new Error('Invalid transcript cursor');
    if (cursor[2] !== generation) throw new Error('STALE_TRANSCRIPT_CURSOR');
    seq = cursor[3] as number;
  } else if (newer) throw new Error('Loading newer entries requires a cursor');
  const tip = await runtime.lane.getTipId(context);
  if (!tip)
    return {
      entries: [],
      context: [],
      startCursor: null,
      endCursor: null,
      olderCursor: null,
      newerCursor: null,
      generation,
    };
  const rows = await runtime.lane.findEntries(
    {
      start: tip,
      order: newer ? 'oldestFirst' : 'newestFirst',
      limit: limit + 1,
      ...(seq === undefined ? {} : { cursor: { seq } }),
    },
    context,
  );
  const more = rows.length > limit;
  const entries = rows.slice(0, limit);
  if (!newer) entries.reverse();
  const encode = (position: number): string =>
    transcriptCursor(runtime.sessionId, runtime.laneName, generation, position);
  const first = entries[0];
  const last = entries.at(-1);
  const identities = first
    ? await runtime.lane.findEntries(
        {
          start: tip,
          type: 'custom',
          customType: 'doom-profile-identity',
          order: 'newestFirst',
          limit: 1,
          cursor: { seq: first.seq },
        },
        context,
      )
    : [];
  return {
    entries: JSON.parse(JSON.stringify(entries)) as JsonValue[],
    context: JSON.parse(JSON.stringify(identities)) as JsonValue[],
    startCursor: first ? encode(first.seq) : null,
    endCursor: last ? encode(last.seq) : null,
    olderCursor: first && (newer ? seq !== undefined : more) ? encode(first.seq) : null,
    newerCursor: last && (newer ? more : seq !== undefined) ? encode(last.seq) : null,
    generation,
  };
}

/** Protocol identities are strings; durable record IDs remain numeric internally. */
export function projectDurableEntries(
  records: readonly import('@earendil-works/pi-durable').EntryRecord[],
): import('../../types/server/directHarnessRuntime').Entry[] {
  return records.flatMap((raw, index) => {
    const data = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : undefined;
    const message = raw.model?.[0];
    const timestamp =
      message && 'timestamp' in message && typeof message.timestamp === 'number'
        ? message.timestamp
        : typeof data?.timestamp === 'number'
          ? data.timestamp
          : 0;
    const base = {
      id: String(raw.id),
      parentId: index ? String(records[index - 1]!.id) : null,
      timestamp,
      seq: Number(raw.id),
    };
    if (raw.kind === 'doompi.entry' && data)
      return [{ ...data, ...base } as import('../../types/server/directHarnessRuntime').Entry];
    if (raw.kind === 'pi.compaction') {
      const content = message?.content;
      const summary =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('')
            : '';
      return [{ ...base, type: 'compaction' as const, summary, tokensBefore: 0, retainedTail: [], fromHook: false }];
    }
    if (raw.model?.length)
      return raw.model.map((item, position) => ({
        ...base,
        id: position === 0 ? base.id : `${base.id}:${position}`,
        type: 'message' as const,
        message: item,
      }));
    return [
      { ...base, type: 'custom' as const, customType: raw.kind, ...(raw.data === undefined ? {} : { data: raw.data }) },
    ];
  });
}
