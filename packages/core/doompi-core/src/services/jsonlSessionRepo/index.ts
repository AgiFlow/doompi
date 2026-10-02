import { createHash } from 'node:crypto';

import type { HistoryImportVerification, HistoryStagingImportInput } from '../historyImport';
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = asRecord(value);
  if (record === undefined) return JSON.stringify(value) ?? 'null';
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

export function contentHash(record: Record<string, unknown>): string {
  const { id: _id, parentId: _parentId, timestamp: _timestamp, kind: _kind, seq: _seq, ...content } = record;
  if (content.type === 'custom_message') {
    content.type = 'message';
    content.message = {
      role: 'custom',
      customType: content.customType,
      content: content.content,
      details: content.details,
      display: content.display,
    };
    delete content.customType;
    delete content.content;
    delete content.details;
    delete content.display;
  }
  if (content.type === 'branch_summary' && content.fromId === 'root') content.fromId = null;
  if (content.type === 'compaction') {
    delete content.firstKeptEntryId;
    delete content.retainedTail;
  }
  return createHash('sha256')
    .update(Buffer.from(stableJson(content)))
    .digest('hex');
}

/** Retained legacy entrypoint. Fresh durable sessions do not import old journals. */
export async function importV3WithPinnedUpstream(
  _input: HistoryStagingImportInput,
): Promise<HistoryImportVerification> {
  throw new Error('Legacy history import is unsupported by fresh durable storage');
}
