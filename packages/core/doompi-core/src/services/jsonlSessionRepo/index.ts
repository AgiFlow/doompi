import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core/harness/context';
import { JSONL_STORAGE_VERSION, JsonlSessionRepo } from '@earendil-works/pi-agent-core/harness/session';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';

import type { HistoryEntryProof, HistoryImportVerification, HistoryStagingImportInput } from '../historyImport';

const PROJECTED_V3_TYPES = new Set([
  'model_change',
  'thinking_level_change',
  'active_tools_change',
  'session_info',
  'label',
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid protected history ${field}`);
  return value;
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== 'string') throw new Error(`Invalid protected history ${field}`);
  return value;
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

interface ParsedV3 {
  header: Record<string, unknown>;
  records: Record<string, unknown>[];
}

interface ParsedV4 {
  entries: Record<string, unknown>[];
  branchTips: Map<string, string | null>;
}

function parseJsonl(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf8');
  if (!content.endsWith('\n')) throw new Error(`Protected history file is truncated: ${filePath}`);
  return content.slice(0, -1).split('\n');
}

function parseV3(filePath: string): ParsedV3 {
  const lines = parseJsonl(filePath);
  const header = asRecord(JSON.parse(lines[0] ?? ''));
  if (header?.type !== 'session' || header.version !== 3)
    throw new Error(`Protected history source is not v3: ${filePath}`);
  const records = lines.slice(1).map((line, index) => {
    const record = asRecord(JSON.parse(line));
    if (record === undefined) throw new Error(`Invalid protected history record at line ${index + 2}`);
    return record;
  });
  return { header, records };
}

function parseV4(filePath: string): ParsedV4 {
  const lines = parseJsonl(filePath);
  const header = asRecord(JSON.parse(lines[0] ?? ''));
  if (header?.kind !== 'header' || header.v !== 4) throw new Error(`Protected history staging is not v4: ${filePath}`);
  const entries: Record<string, unknown>[] = [];
  const branchTips = new Map<string, string | null>();
  for (const line of lines.slice(1)) {
    const value: unknown = JSON.parse(line);
    const writes = Array.isArray(value) ? value : [value];
    for (const item of writes) {
      const record = asRecord(item);
      if (record?.kind === 'entry') {
        const { kind: _kind, seq: _seq, ...entry } = record;
        entries.push(entry);
      } else if (record?.kind === 'value' && record.namespace === 'pi.branch.tip') {
        const branch = requireString(record.key, 'branch name');
        branchTips.set(branch, record.op === 'delete' ? null : requireNullableString(record.value, 'branch tip'));
      }
    }
  }
  return { entries, branchTips };
}

function sourceParentId(record: Record<string, unknown>): string | null {
  return requireNullableString(record.parentId, 'source parent id');
}

function retainedSourceRecords(records: Record<string, unknown>[]): Record<string, unknown>[] {
  return records.filter((record) => !PROJECTED_V3_TYPES.has(requireString(record.type, 'record type')));
}

function resolveNearestRetainedSourceId(
  sourceId: string | null,
  sourceById: Map<string, Record<string, unknown>>,
  sourceToImported: Map<string, string>,
): string | null {
  const visited = new Set<string>();
  let current = sourceId;
  while (current !== null) {
    if (sourceToImported.has(current)) return current;
    if (visited.has(current)) throw new Error(`Cycle in protected history parent chain: ${current}`);
    visited.add(current);
    const record = sourceById.get(current);
    if (record === undefined) throw new Error(`Protected history parent references unknown entry: ${current}`);
    current = sourceParentId(record);
  }
  return null;
}

function resolveRetainedSourceId(
  sourceId: string | null,
  sourceById: Map<string, Record<string, unknown>>,
  sourceToImported: Map<string, string>,
): string | null {
  const retainedSourceId = resolveNearestRetainedSourceId(sourceId, sourceById, sourceToImported);
  return retainedSourceId === null ? null : sourceToImported.get(retainedSourceId)!;
}

function buildVerification(source: ParsedV3, imported: ParsedV4): HistoryImportVerification {
  const retained = retainedSourceRecords(source.records);
  if (imported.entries.length !== retained.length)
    throw new Error('Protected history staging entry count does not match source');

  const sourceById = new Map<string, Record<string, unknown>>();
  for (const record of source.records) {
    const id = requireString(record.id, 'source entry id');
    if (sourceById.has(id)) throw new Error(`Duplicate protected history source entry id: ${id}`);
    sourceById.set(id, record);
  }

  const sourceToImported = new Map<string, string>();
  const importedIds = new Set<string>();
  for (const [index, sourceRecord] of retained.entries()) {
    const sourceId = requireString(sourceRecord.id, 'source entry id');
    const importedRecord = imported.entries[index];
    if (importedRecord === undefined) throw new Error(`Protected history staging omitted source entry: ${sourceId}`);
    const importedId = requireString(importedRecord.id, 'imported entry id');
    if (sourceToImported.has(sourceId)) throw new Error(`Duplicate protected history source entry id: ${sourceId}`);
    if (importedIds.has(importedId)) throw new Error(`Duplicate protected history imported entry id: ${importedId}`);
    sourceToImported.set(sourceId, importedId);
    importedIds.add(importedId);
  }

  const entries: HistoryEntryProof[] = retained.map((sourceRecord) => {
    const sourceId = requireString(sourceRecord.id, 'source entry id');
    const importedId = sourceToImported.get(sourceId);
    if (importedId === undefined) throw new Error(`Protected history omitted source entry: ${sourceId}`);
    const importedRecord = imported.entries.find((record) => record.id === importedId);
    if (importedRecord === undefined) throw new Error(`Protected history omitted imported entry: ${importedId}`);
    const importedParentId = requireNullableString(importedRecord.parentId, 'imported parent id');
    const expectedParentId = resolveRetainedSourceId(sourceParentId(sourceRecord), sourceById, sourceToImported);
    if (expectedParentId !== importedParentId) throw new Error(`Protected history parent mismatch: ${sourceId}`);
    return {
      sourceId,
      importedId,
      sourceParentId: sourceParentId(sourceRecord),
      importedParentId,
      sourceContentHash: contentHash(sourceRecord),
      importedContentHash: contentHash(importedRecord),
    };
  });

  const finalSource = source.records.at(-1);
  const sourceTipId =
    finalSource === undefined
      ? null
      : resolveNearestRetainedSourceId(requireString(finalSource.id, 'source tip id'), sourceById, sourceToImported);
  const importedTipId = sourceTipId === null ? null : sourceToImported.get(sourceTipId);
  if (sourceTipId !== null && importedTipId === undefined)
    throw new Error(`Protected history omitted source tip: ${sourceTipId}`);
  const importedMainTip = imported.branchTips.get('main');
  if (importedMainTip !== (importedTipId ?? null))
    throw new Error('Protected history staging main branch tip mismatch');

  return {
    entries,
    branches: [{ sourceTipId, importedTipId: importedTipId ?? null, branch: 'main' }],
    projectedSourceIds: source.records
      .filter((record) => PROJECTED_V3_TYPES.has(requireString(record.type, 'record type')))
      .map((record) => requireString(record.id, 'projected source entry id')),
  };
}

/** Import one v3 history through the pinned upstream JsonlSessionRepo adapter. */
export async function importV3WithPinnedUpstream(input: HistoryStagingImportInput): Promise<HistoryImportVerification> {
  const source = parseV3(input.sourcePath);
  const timestamp = requireString(source.header.timestamp, 'session timestamp');
  const createdAt = Date.parse(timestamp);
  if (!Number.isFinite(createdAt)) throw new Error('Invalid protected history session timestamp');
  const cwd = requireString(source.header.cwd, 'session cwd');
  const id = requireString(source.header.id, 'session id');
  const environment = new NodeExecutionEnv({ cwd: path.dirname(path.resolve(input.stagingPath)) });
  const repository = new JsonlSessionRepo({
    fileSystem: environment,
    sessionsRoot: path.dirname(path.resolve(input.stagingPath)),
    now: () => Date.now(),
  });
  let session: Awaited<ReturnType<JsonlSessionRepo['open']>> | undefined;
  try {
    session = await repository.open(
      {
        id,
        createdAt,
        storageVersion: JSONL_STORAGE_VERSION,
        cwd,
        path: path.resolve(input.stagingPath),
        modifiedAt: fs.statSync(input.stagingPath).mtimeMs,
      },
      BACKGROUND_CONTEXT,
    );
    const name = await session.getName(BACKGROUND_CONTEXT);
    await session.setName(name, BACKGROUND_CONTEXT);
    await session.close(BACKGROUND_CONTEXT);
    session = undefined;
    return buildVerification(source, parseV4(input.stagingPath));
  } finally {
    if (session !== undefined) await session.close(BACKGROUND_CONTEXT).catch(() => undefined);
    await repository.close(BACKGROUND_CONTEXT);
    await environment.cleanup(BACKGROUND_CONTEXT);
  }
}
