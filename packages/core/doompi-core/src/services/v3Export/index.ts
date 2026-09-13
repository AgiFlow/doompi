import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { HistoryOwnership, HistoryOwnershipLease } from '../historyImport';
export interface V3ExportLoss {
  code: string;
  detail: string;
  record?: unknown;
}

export interface V3ExportLossReport {
  version: 1;
  format: 'doompi-v4-to-v3-loss-report';
  sourcePath: string;
  sourceSha256: string;
  destinationPath: string;
  losses: readonly V3ExportLoss[];
}

export interface V3ExportOptions {
  sourcePath: string;
  destinationPath: string;
  owner: HistoryOwnership;
  reportPath?: string;
  statePath?: string;
}

export interface V3ExportResult {
  status: 'published' | 'already-published';
  sourcePath: string;
  destinationPath: string;
  reportPath: string;
  statePath: string;
  sourceSha256: string;
  losses: readonly V3ExportLoss[];
}

interface V4Header {
  v: 4;
  kind: 'header';
  id: string;
  storageVersion: number;
  createdAt: number;
  cwd: string;
  parentSessionId?: string;
  legacyParentSessionPath?: string;
  [key: string]: unknown;
}

interface V4EntryWrite {
  kind: 'entry';
  entry: Record<string, unknown>;
  seq: number;
}

interface V4UsageWrite {
  kind: 'usage';
  row: Record<string, unknown>;
  seq: number;
}

interface V4ValueWrite {
  kind: 'value';
  op: 'set' | 'delete';
  namespace: string;
  key: string;
  value?: unknown;
  seq: number;
}

interface V4ListWrite {
  kind: 'list';
  op: 'append' | 'delete';
  namespace: string;
  key: string;
  value?: unknown;
  seq: number;
}

type V4Write = V4EntryWrite | V4UsageWrite | V4ValueWrite | V4ListWrite;

interface SourceIdentity {
  device: number;
  inode: number;
  size: number;
  mtimeMs: number;
}

interface SourceSnapshot {
  content: Buffer;
  sourceSha256: string;
  identity: SourceIdentity;
}

interface ExportState {
  version: 1;
  operation: 'v4-to-v3-export';
  phase: 'staged' | 'published';
  sourcePath: string;
  destinationPath: string;
  reportPath: string;
  sourceSha256: string;
  sourceIdentity: SourceIdentity;
  destinationSha256: string;
  reportSha256: string;
  stagingPath: string;
  reportStagingPath: string;
}

const EXPORT_STATE_VERSION = 1;
const EXPORT_OPERATION = 'v4-to-v3-export';
const SESSION_NAME_NAMESPACE = 'pi.session.name';
const ENTRY_LABEL_NAMESPACE = 'pi.entry.label';
const BRANCH_TIP_NAMESPACE = 'pi.branch.tip';

interface ProtectedEntryProof {
  sourceId: string;
  importedId: string;
  sourceParentId: string | null;
  importedParentId: string | null;
  sourceContentHash: string;
  importedContentHash: string;
}

interface ProtectedBranchProof {
  sourceTipId: string | null;
  importedTipId: string | null;
  branch?: string;
}

interface ProtectedSourceIdentity {
  path: string;
  realPath: string;
  device: number;
  inode: number;
  size: number;
  mtimeMs: number;
  sha256: string;
}

interface ProtectedImportState {
  sourcePath: string;
  destinationPath: string;
  originalPath: string;
  sourceIdentity: ProtectedSourceIdentity;
  stagedSha256: string;
  entries: ProtectedEntryProof[];
  branches: ProtectedBranchProof[];
  projectedSourceIds: string[];
}

interface MetadataTimestamp {
  timestamp: string;
  parentId: string | null;
  targetId?: string;
  value?: string;
}

interface MetadataProvenance {
  sessionName?: MetadataTimestamp;
  labels: Map<string, MetadataTimestamp>;
}

function nullableString(value: unknown): string | null | undefined {
  return value === null ? null : typeof value === 'string' ? value : undefined;
}

function parseProtectedSourceIdentity(value: unknown): ProtectedSourceIdentity | undefined {
  const record = asRecord(value);
  if (
    typeof record?.path !== 'string' ||
    typeof record.realPath !== 'string' ||
    typeof record.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.sha256)
  ) {
    return undefined;
  }
  const number = (field: string): number | undefined => {
    const candidate = record[field];
    return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : undefined;
  };
  const device = number('device');
  const inode = number('inode');
  const size = number('size');
  const mtimeMs = record.mtimeMs;
  if (
    device === undefined ||
    inode === undefined ||
    size === undefined ||
    typeof mtimeMs !== 'number' ||
    !Number.isFinite(mtimeMs) ||
    mtimeMs < 0
  ) {
    return undefined;
  }
  return { path: record.path, realPath: record.realPath, device, inode, size, mtimeMs, sha256: record.sha256 };
}

function parseProtectedImportState(value: unknown): ProtectedImportState | undefined {
  const record = asRecord(value);
  const sourceIdentity = parseProtectedSourceIdentity(record?.sourceIdentity);
  const verification = asRecord(record?.verification);
  if (
    record?.version !== 1 ||
    record.operation !== 'protected-history-import' ||
    record.phase !== 'published' ||
    typeof record.sourcePath !== 'string' ||
    typeof record.destinationPath !== 'string' ||
    typeof record.originalPath !== 'string' ||
    typeof sourceIdentity?.path !== 'string' ||
    path.resolve(sourceIdentity.path) !== path.resolve(record.sourcePath) ||
    typeof sourceIdentity.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sourceIdentity.sha256) ||
    typeof record.stagedSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.stagedSha256) ||
    !Array.isArray(verification?.entries) ||
    !Array.isArray(verification.branches)
  ) {
    return undefined;
  }
  const entries: ProtectedEntryProof[] = [];
  for (const item of verification.entries) {
    const proof = asRecord(item);
    const sourceParentId = nullableString(proof?.sourceParentId);
    const importedParentId = nullableString(proof?.importedParentId);
    if (
      typeof proof?.sourceId !== 'string' ||
      typeof proof.importedId !== 'string' ||
      sourceParentId === undefined ||
      importedParentId === undefined ||
      typeof proof.sourceContentHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(proof.sourceContentHash) ||
      typeof proof.importedContentHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(proof.importedContentHash)
    ) {
      return undefined;
    }
    entries.push({
      sourceId: proof.sourceId,
      importedId: proof.importedId,
      sourceParentId,
      importedParentId,
      sourceContentHash: proof.sourceContentHash,
      importedContentHash: proof.importedContentHash,
    });
  }
  const branches: ProtectedBranchProof[] = [];
  for (const item of verification.branches) {
    const proof = asRecord(item);
    const sourceTipId = nullableString(proof?.sourceTipId);
    const importedTipId = nullableString(proof?.importedTipId);
    if (sourceTipId === undefined || importedTipId === undefined) return undefined;
    if (proof?.branch !== undefined && typeof proof.branch !== 'string') return undefined;
    branches.push({
      sourceTipId,
      importedTipId,
      ...(proof?.branch === undefined ? {} : { branch: proof.branch }),
    });
  }
  const projected = verification.projectedSourceIds;
  if (
    !Array.isArray(projected) ||
    projected.some((id) => typeof id !== 'string' || id.length === 0) ||
    new Set(projected).size !== projected.length
  ) {
    return undefined;
  }
  return {
    sourcePath: record.sourcePath,
    destinationPath: record.destinationPath,
    originalPath: record.originalPath,
    sourceIdentity,
    stagedSha256: record.stagedSha256,
    entries,
    branches,
    projectedSourceIds: projected,
  };
}

interface OriginalV3 {
  header: Record<string, unknown>;
  records: Record<string, unknown>[];
  byId: Map<string, Record<string, unknown>>;
}

function parseOriginalV3(content: Uint8Array): OriginalV3 | undefined {
  const text = Buffer.from(content).toString('utf8');
  if (Buffer.from(text).compare(Buffer.from(content)) !== 0 || !text.endsWith('\n')) return undefined;
  const lines = text.slice(0, -1).split('\n');
  let header: Record<string, unknown> | undefined;
  try {
    header = asRecord(JSON.parse(lines[0] ?? ''));
  } catch {
    return undefined;
  }
  if (header?.type !== 'session' || header.version !== 3) return undefined;
  const records: Record<string, unknown>[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const line of lines.slice(1)) {
    if (line.length === 0) return undefined;
    let record: Record<string, unknown> | undefined;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      return undefined;
    }
    if (record === undefined || typeof record.id !== 'string' || byId.has(record.id)) return undefined;
    records.push(record);
    byId.set(record.id, record);
  }
  return { header, records, byId };
}
function provenanceStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(provenanceStableJson).join(',')}]`;
  const record = asRecord(value);
  if (record === undefined) return JSON.stringify(value) ?? 'null';
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${provenanceStableJson(record[key])}`)
    .join(',')}}`;
}

function metadataTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(Date.parse(value)).toISOString();
}

function provenanceContentHash(record: Record<string, unknown>): string {
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
  return digest(Buffer.from(provenanceStableJson(content)));
}
function sameProtectedSourceIdentity(left: ProtectedSourceIdentity, right: ProtectedSourceIdentity): boolean {
  return (
    left.path === right.path &&
    left.realPath === right.realPath &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256
  );
}

function resolveProvenanceParent(
  sourceId: string | null,
  sourceById: Map<string, Record<string, unknown>>,
  mappings: Map<string, ProtectedEntryProof>,
): string | null | undefined {
  const visited = new Set<string>();
  let current = sourceId;
  while (current !== null) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const mapping = mappings.get(current);
    if (mapping !== undefined) return mapping.importedId;
    const record = sourceById.get(current);
    if (record === undefined) return undefined;
    const parentId = nullableString(record.parentId);
    if (parentId === undefined) return undefined;
    current = parentId;
  }
  return null;
}

function readMetadataProvenance(
  sourcePath: string,
  snapshot: SourceSnapshot,
  parsed: { header: V4Header; writes: V4Write[] },
  entryRecords: Record<string, unknown>[],
): MetadataProvenance | undefined {
  const statePath = `${sourcePath}.import-state.json`;
  if (!fs.existsSync(statePath)) return undefined;
  let state: ProtectedImportState | undefined;
  try {
    state = parseProtectedImportState(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  } catch {
    return undefined;
  }
  if (state === undefined) return undefined;
  let currentSourceIdentity: ProtectedSourceIdentity;
  try {
    const current = readSourceSnapshot(state.sourcePath);
    currentSourceIdentity = {
      path: path.resolve(state.sourcePath),
      realPath: fs.realpathSync(state.sourcePath),
      ...current.identity,
      sha256: current.sourceSha256,
    };
  } catch {
    return undefined;
  }
  let originalContent: Buffer;
  try {
    originalContent = fs.readFileSync(path.resolve(state.originalPath));
  } catch {
    return undefined;
  }
  if (
    !sameProtectedSourceIdentity(state.sourceIdentity, currentSourceIdentity) ||
    path.resolve(state.destinationPath) !== sourcePath ||
    path.resolve(state.originalPath) !== `${path.resolve(state.sourcePath)}.original` ||
    digest(snapshot.content) !== state.stagedSha256 ||
    state.sourceIdentity.sha256 !== digest(originalContent)
  ) {
    return undefined;
  }
  const original = parseOriginalV3(originalContent);
  if (
    original === undefined ||
    original.header.id !== parsed.header.id ||
    original.header.cwd !== parsed.header.cwd ||
    metadataTimestamp(original.header.timestamp) !== new Date(parsed.header.createdAt).toISOString()
  ) {
    return undefined;
  }

  const sourceById = original.byId;
  const mappings = new Map<string, ProtectedEntryProof>();
  const importedIds = new Set<string>();
  const canonicalById = new Map(entryRecords.map((entry) => [String(entry.id), entry]));
  for (const proof of state.entries) {
    if (mappings.has(proof.sourceId) || importedIds.has(proof.importedId)) return undefined;
    mappings.set(proof.sourceId, proof);
    importedIds.add(proof.importedId);
  }
  for (const proof of state.entries) {
    const source = sourceById.get(proof.sourceId);
    const imported = canonicalById.get(proof.importedId);
    if (
      source === undefined ||
      imported === undefined ||
      proof.sourceContentHash !== proof.importedContentHash ||
      proof.sourceContentHash !== provenanceContentHash(source) ||
      proof.importedContentHash !== provenanceContentHash(imported) ||
      nullableString(source.parentId) !== proof.sourceParentId ||
      nullableString(imported.parentId) !== proof.importedParentId ||
      metadataTimestamp(source.timestamp) !== metadataTimestamp(imported.timestamp) ||
      resolveProvenanceParent(proof.sourceParentId, sourceById, mappings) !== proof.importedParentId
    ) {
      return undefined;
    }
  }
  if (mappings.size !== entryRecords.length) return undefined;
  const projected = new Set(state.projectedSourceIds);
  for (const source of original.records) {
    const id = String(source.id);
    if (!mappings.has(id) && !projected.has(id)) return undefined;
    if (projected.has(id) && mappings.has(id)) return undefined;
  }
  for (const branch of state.branches) {
    if (
      branch.sourceTipId === null
        ? branch.importedTipId !== null
        : mappings.get(branch.sourceTipId)?.importedId !== branch.importedTipId
    ) {
      return undefined;
    }
    if (branch.branch !== undefined) {
      const current = [...parsed.writes]
        .filter(
          (write): write is V4ValueWrite =>
            write.kind === 'value' && write.namespace === BRANCH_TIP_NAMESPACE && write.key === branch.branch,
        )
        .sort((left, right) => left.seq - right.seq)
        .at(-1);
      const currentTip = current === undefined || current.op === 'delete' ? null : nullableString(current.value);
      if (currentTip !== branch.importedTipId) return undefined;
    }
  }

  const labels = new Map<string, MetadataTimestamp | null>();
  let sourceSessionName: MetadataTimestamp | undefined;
  for (const source of original.records) {
    const id = String(source.id);
    if (!projected.has(id)) continue;
    const timestamp = metadataTimestamp(source.timestamp);
    if (timestamp === undefined) return undefined;
    if (source.type === 'session_info') {
      if (typeof source.name !== 'string' || source.name.length === 0) sourceSessionName = undefined;
      else sourceSessionName = { timestamp, parentId: null, value: source.name };
    } else if (source.type === 'label') {
      const sourceTarget = typeof source.targetId === 'string' ? source.targetId : undefined;
      const targetId =
        sourceTarget === undefined ? undefined : resolveProvenanceParent(sourceTarget, sourceById, mappings);
      const sourceParentId = nullableString(source.parentId);
      if (sourceParentId === undefined || targetId === undefined) return undefined;
      if (targetId === null) continue;
      const parentId = resolveProvenanceParent(sourceParentId, sourceById, mappings);
      if (parentId === undefined) return undefined;
      labels.set(
        targetId,
        typeof source.label === 'string' && source.label.length > 0
          ? { timestamp, parentId, targetId, value: source.label }
          : null,
      );
    }
  }
  const currentLabels = new Map<string, V4ValueWrite>();
  let currentName: V4ValueWrite | undefined;
  for (const write of [...parsed.writes].sort((left, right) => left.seq - right.seq)) {
    if (write.kind !== 'value') continue;
    if (write.namespace === ENTRY_LABEL_NAMESPACE) currentLabels.set(write.key, write);
    if (write.namespace === SESSION_NAME_NAMESPACE && write.key === '') currentName = write;
  }
  const expectedLabels = new Map<string, MetadataTimestamp>();
  for (const [targetId, metadata] of labels) {
    const current = currentLabels.get(targetId);
    if (metadata === null) {
      if (current !== undefined && current.op !== 'delete') return undefined;
    } else {
      if (current?.op !== 'set' || current.value !== metadata.value) return undefined;
      expectedLabels.set(targetId, metadata);
    }
  }
  for (const [targetId, current] of currentLabels) {
    if (current.op === 'set' && (!expectedLabels.has(targetId) || typeof current.value !== 'string')) return undefined;
  }
  if (sourceSessionName === undefined) {
    if (currentName?.op === 'set') return undefined;
  } else if (
    currentName?.op !== 'set' ||
    currentName.value !==
      original.records.findLast((record) => projected.has(String(record.id)) && record.type === 'session_info')?.name
  ) {
    return undefined;
  }
  return { sessionName: sourceSessionName, labels: new Map(expectedLabels) };
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid v4 ${field}`);
  return value;
}

function requireKey(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid v4 ${field}`);
  return value;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid v4 ${field}`);
  return value;
}

function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid v4 ${field}`);
  return value;
}

function digest(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function sameIdentity(left: SourceIdentity, right: SourceIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function readSourceSnapshot(sourcePath: string): SourceSnapshot {
  const before = fs.statSync(sourcePath);
  const content = fs.readFileSync(sourcePath);
  const after = fs.statSync(sourcePath);
  const identity = {
    device: after.dev,
    inode: after.ino,
    size: after.size,
    mtimeMs: after.mtimeMs,
  };
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    after.size !== content.byteLength
  ) {
    throw new Error('v4 source changed while it was being read');
  }
  return { content, sourceSha256: digest(content), identity };
}

function assertSourceUnchanged(sourcePath: string, snapshot: SourceSnapshot): void {
  const current = readSourceSnapshot(sourcePath);
  if (!sameIdentity(current.identity, snapshot.identity) || current.sourceSha256 !== snapshot.sourceSha256) {
    throw new Error('v4 source changed during export');
  }
}
function readJsonLines(content: Buffer): { header: V4Header; writes: V4Write[]; losses: V3ExportLoss[] } {
  if (content.byteLength === 0) throw new Error('Cannot export an empty v4 JSONL file');
  if (!content.toString('utf8').endsWith('\n')) throw new Error('Cannot export a truncated v4 JSONL file');
  const lines = content.toString('utf8').slice(0, -1).split('\n');
  if (lines[0] === undefined || lines[0].length === 0) throw new Error('Cannot export an empty v4 JSONL file');
  const headerValue = asRecord(JSON.parse(lines[0]));
  if (headerValue?.v !== 4 || headerValue.kind !== 'header') throw new Error('Source is not v4 JSONL');
  const header = headerValue as V4Header;
  requireString(header.id, 'header id');
  requireNumber(header.storageVersion, 'storage version');
  requireTimestamp(header.createdAt, 'header createdAt');
  requireString(header.cwd, 'header cwd');
  if (header.parentSessionId !== undefined) requireString(header.parentSessionId, 'parent session id');
  if (header.legacyParentSessionPath !== undefined)
    requireString(header.legacyParentSessionPath, 'legacy parent session path');
  const writes: V4Write[] = [];
  const losses: V3ExportLoss[] = [];
  const knownHeaderFields = new Set([
    'v',
    'kind',
    'id',
    'storageVersion',
    'createdAt',
    'cwd',
    'parentSessionId',
    'legacyParentSessionPath',
  ]);
  for (const [key, value] of Object.entries(headerValue)) {
    if (!knownHeaderFields.has(key)) {
      losses.push({
        code: 'unknown-header-field',
        detail: `Header field ${key} is not representable in v3`,
        record: { key, value },
      });
    }
  }
  for (const [lineIndex, line] of lines.slice(1).entries()) {
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid v4 JSONL transaction at line ${lineIndex + 2}`, { cause: error });
    }
    const transaction = Array.isArray(value) ? value : [value];
    for (const item of transaction) {
      const record = asRecord(item);
      if (record === undefined) {
        losses.push({
          code: 'unknown-record',
          detail: `Non-object transaction at line ${lineIndex + 2}`,
          record: item,
        });
        continue;
      }
      const kind = record.kind;
      if (kind === 'entry') {
        const seq = requireNumber(record.seq, 'entry sequence');
        const { kind: _kind, seq: _seq, ...entry } = record;
        writes.push({ kind, entry, seq });
      } else if (kind === 'usage') {
        const seq = requireNumber(record.seq, 'usage sequence');
        const { kind: _kind, seq: _seq, ...row } = record;
        writes.push({ kind, row, seq });
      } else if (kind === 'value' && (record.op === 'set' || record.op === 'delete')) {
        writes.push({
          kind,
          op: record.op,
          namespace: requireString(record.namespace, 'value namespace'),
          key: requireKey(record.key, 'value key'),
          ...(record.value === undefined ? {} : { value: record.value }),
          seq: requireNumber(record.seq, 'value sequence'),
        });
      } else if (kind === 'list' && (record.op === 'append' || record.op === 'delete')) {
        writes.push({
          kind,
          op: record.op,
          namespace: requireString(record.namespace, 'list namespace'),
          key: requireKey(record.key, 'list key'),
          ...(record.value === undefined ? {} : { value: record.value }),
          seq: requireNumber(record.seq, 'list sequence'),
        });
      } else {
        losses.push({ code: 'unknown-write', detail: `Unsupported v4 write at line ${lineIndex + 2}`, record });
      }
    }
  }
  return { header, writes, losses };
}

function isoTimestamp(timestamp: unknown, field: string): string {
  const value = requireTimestamp(timestamp, field);
  const result = new Date(value).toISOString();
  if (Number.isNaN(Date.parse(result))) throw new Error(`Invalid v4 ${field}`);
  return result;
}

function deterministicId(sourceSha256: string, kind: string, key: string): string {
  const bytes = createHash('sha256').update(`${sourceSha256}\0${kind}\0${key}`).digest('hex');
  return `doom-${bytes.slice(0, 32)}`;
}

function messageForEntry(entry: Record<string, unknown>): unknown {
  return entry.type === 'message' ? entry.message : undefined;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function findCompactionFirstKeptId(
  entry: Record<string, unknown>,
  entries: Map<string, Record<string, unknown>>,
): string | undefined {
  const retainedTail = entry.retainedTail;
  if (!Array.isArray(retainedTail)) return undefined;
  if (retainedTail.length === 0) return typeof entry.parentId === 'string' ? entry.parentId : undefined;
  const ancestry: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let currentId = typeof entry.parentId === 'string' ? entry.parentId : null;
  while (currentId !== null) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const current = entries.get(currentId);
    if (current === undefined) return undefined;
    ancestry.unshift(current);
    currentId = typeof current.parentId === 'string' ? current.parentId : null;
  }
  for (let index = 0; index + retainedTail.length <= ancestry.length; index += 1) {
    const candidate = ancestry.slice(index, index + retainedTail.length);
    if (candidate.every((item, itemIndex) => sameJson(messageForEntry(item), retainedTail[itemIndex]))) {
      const id = candidate[0]?.id;
      if (typeof id === 'string') return id;
    }
  }
  return undefined;
}

function attachUsage(entry: Record<string, unknown>, usage: unknown): Record<string, unknown> {
  if (entry.type === 'message' && asRecord(entry.message)?.role !== undefined) {
    return { ...entry, message: { ...(asRecord(entry.message) as Record<string, unknown>), usage } };
  }
  if (entry.type === 'compaction' || entry.type === 'branch_summary') return { ...entry, usage };
  return entry;
}

function convertEntries(
  entryWrites: V4EntryWrite[],
  usageWrites: V4UsageWrite[],
  losses: V3ExportLoss[],
): Record<string, unknown>[] {
  const entries = new Map<string, Record<string, unknown>>();
  for (const write of entryWrites) {
    const id = requireString(write.entry.id, 'entry id');
    if (entries.has(id)) throw new Error(`Duplicate v4 entry id: ${id}`);
    entries.set(id, write.entry);
  }
  for (const entry of entries.values()) {
    const parentId = entry.parentId;
    if (parentId !== null && (typeof parentId !== 'string' || !entries.has(parentId))) {
      throw new Error(`Missing v4 entry parent: ${JSON.stringify(parentId)}`);
    }
  }

  const usageByEntry = new Map<string, unknown>();
  for (const write of [...usageWrites].sort((left, right) => left.seq - right.seq)) {
    const entryId = write.row.entryId;
    if (typeof entryId !== 'string' || !entries.has(entryId) || write.row.usage === undefined) {
      losses.push({
        code: 'usage-not-representable',
        detail: 'Usage row has no representable entry target',
        record: write.row,
      });
      continue;
    }
    if (usageByEntry.has(entryId)) {
      losses.push({
        code: 'usage-multiple-rows',
        detail: `Multiple usage rows target entry ${entryId}; v3 retains only the latest usage value`,
        record: write.row,
      });
    }
    if (write.row.adjustment !== false || write.row.details !== undefined) {
      losses.push({
        code: 'usage-metadata',
        detail: `Usage metadata for entry ${entryId} is not representable in v3`,
        record: write.row,
      });
    }
    usageByEntry.set(entryId, write.row.usage);
  }

  const ordered = [...entryWrites].sort((left, right) => left.seq - right.seq);
  return ordered
    .map((write): Record<string, unknown> | undefined => {
      const source = write.entry;
      const type = requireString(source.type, 'entry type');
      const id = requireString(source.id, 'entry id');
      const parentId = source.parentId;
      if (typeof parentId !== 'string' && parentId !== null) throw new Error(`Invalid v4 parent id: ${id}`);
      const base: Record<string, unknown> = {
        ...source,
        type,
        id,
        parentId,
        timestamp: isoTimestamp(source.timestamp, 'entry timestamp'),
      };
      delete base.kind;
      delete base.seq;
      if (type === 'branch_summary') {
        if (base.fromId === null) base.fromId = 'root';
        else if (typeof base.fromId !== 'string') throw new Error(`Invalid v4 branch summary source: ${id}`);
      }
      if (type === 'compaction') {
        const firstKeptEntryId = findCompactionFirstKeptId(source, entries);
        if (firstKeptEntryId === undefined) {
          losses.push({
            code: 'compaction-retained-tail',
            detail: `Compaction ${id} retained tail cannot be mapped to v3 firstKeptEntryId`,
            record: source,
          });
          if (typeof parentId === 'string') base.firstKeptEntryId = parentId;
          else return undefined;
        } else {
          base.firstKeptEntryId = firstKeptEntryId;
        }
        delete base.retainedTail;
      } else if (type === 'custom') {
        requireString(source.customType, 'custom entry type');
      } else if (type !== 'message' && type !== 'branch_summary') {
        losses.push({ code: 'entry-type', detail: `Entry type ${type} is not representable in v3`, record: source });
        return undefined;
      }
      const usage = usageByEntry.get(id);
      return usage === undefined ? base : attachUsage(base, usage);
    })
    .filter((record): record is Record<string, unknown> => record !== undefined);
}

interface ConvertedValues {
  records: Record<string, unknown>[];
  mainTipId: string | null | undefined;
}

function convertValues(
  sourceSha256: string,
  valueWrites: V4ValueWrite[],
  representableEntryIds: ReadonlySet<string>,
  provenance: MetadataProvenance | undefined,
  losses: V3ExportLoss[],
): ConvertedValues {
  const sessionNames = valueWrites.filter((write) => write.namespace === SESSION_NAME_NAMESPACE && write.key === '');
  const labels = new Map<string, V4ValueWrite>();
  const branchTips = new Map<string, V4ValueWrite>();
  for (const write of [...valueWrites].sort((left, right) => left.seq - right.seq)) {
    if (write.namespace === ENTRY_LABEL_NAMESPACE) labels.set(write.key, write);
    else if (write.namespace === BRANCH_TIP_NAMESPACE) {
      branchTips.set(write.key, write);
      if (write.key !== 'main') {
        losses.push({
          code: 'branch-tip-value',
          detail: `Named branch tip ${write.key} is represented by its entry tree only`,
          record: write,
        });
      }
    } else if (write.namespace === SESSION_NAME_NAMESPACE && write.key !== '') {
      losses.push({
        code: 'session-name-key',
        detail: `Session value key ${write.key} is not representable in v3`,
        record: write,
      });
    } else if (write.namespace !== SESSION_NAME_NAMESPACE) {
      losses.push({
        code: 'value-not-representable',
        detail: `Value ${write.namespace}/${write.key} is not representable in v3`,
        record: write,
      });
    }
  }
  const records: Record<string, unknown>[] = [];
  const latestName = [...sessionNames].sort((left, right) => left.seq - right.seq).at(-1);
  if (latestName !== undefined && latestName.op === 'set') {
    if (typeof latestName.value !== 'string') {
      losses.push({ code: 'session-name-value', detail: 'Session name is not a v3 string', record: latestName });
    } else {
      const metadata = provenance?.sessionName;
      if (metadata === undefined) {
        losses.push({
          code: 'value-provenance',
          detail: 'v4 session value has no source event timestamp; v3 session_info was omitted to avoid inventing one',
          record: latestName,
        });
      } else {
        records.push({
          type: 'session_info',
          id: deterministicId(sourceSha256, 'session_info', 'name'),
          parentId: metadata.parentId,
          timestamp: metadata.timestamp,
          name: latestName.value,
        });
      }
    }
  }
  for (const [targetId, write] of [...labels.entries()].sort((left, right) => left[1].seq - right[1].seq)) {
    if (write.op !== 'set') continue;
    if (typeof write.value !== 'string') {
      losses.push({ code: 'label-value', detail: `Label ${targetId} is not a v3 string`, record: write });
      continue;
    }
    if (!representableEntryIds.has(targetId)) {
      losses.push({
        code: 'label-target',
        detail: `Label ${targetId} targets an entry that is not representable in v3`,
        record: write,
      });
      continue;
    }
    const metadata = provenance?.labels.get(targetId);
    if (metadata === undefined) {
      losses.push({
        code: 'value-provenance',
        detail: `v4 label ${targetId} has no source event timestamp; v3 label was omitted to avoid inventing one`,
        record: write,
      });
      continue;
    }
    records.push({
      type: 'label',
      id: deterministicId(sourceSha256, 'label', targetId),
      parentId: metadata.parentId,
      timestamp: metadata.timestamp,
      targetId: metadata.targetId ?? targetId,
      label: write.value,
    });
  }

  const mainTip = branchTips.get('main');
  let mainTipId: string | null | undefined;
  if (mainTip === undefined) {
    if (representableEntryIds.size > 0) {
      losses.push({ code: 'main-tip-missing', detail: 'v4 has no main branch tip; v3 cannot choose a resume tip' });
    }
  } else if (mainTip.op === 'delete' || mainTip.value === null) {
    mainTipId = null;
  } else if (typeof mainTip.value === 'string') {
    mainTipId = mainTip.value;
    if (!representableEntryIds.has(mainTipId)) {
      losses.push({
        code: 'main-tip-not-representable',
        detail: `v4 main branch tip ${mainTipId} is not representable in v3`,
        record: mainTip,
      });
      mainTipId = undefined;
    }
  } else {
    losses.push({
      code: 'main-tip-value',
      detail: 'v4 main branch tip is not a nullable entry id',
      record: mainTip,
    });
  }
  return { records, mainTipId };
}

function orderEntriesForMainTip(
  entries: Record<string, unknown>[],
  mainTipId: string | null | undefined,
  losses: V3ExportLoss[],
): Record<string, unknown>[] {
  if (mainTipId === undefined || mainTipId === null) return entries;
  const tipIndex = entries.findIndex((entry) => entry.id === mainTipId);
  if (tipIndex < 0) return entries;
  if (entries.some((entry) => entry.parentId === mainTipId && entry.id !== mainTipId)) {
    losses.push({
      code: 'main-tip-not-leaf',
      detail: `v4 main branch tip ${mainTipId} has representable descendants; v3 cannot make it the resume tip`,
    });
    return entries;
  }
  const [tip] = entries.splice(tipIndex, 1);
  entries.push(tip!);
  return entries;
}

function serializeV3(header: V4Header, records: Record<string, unknown>[]): string {
  const v3Header: Record<string, unknown> = {
    type: 'session',
    version: 3,
    id: header.id,
    timestamp: isoTimestamp(header.createdAt, 'header createdAt'),
    cwd: header.cwd,
  };
  if (header.legacyParentSessionPath !== undefined) v3Header.parentSession = header.legacyParentSessionPath;
  return `${[v3Header, ...records].map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function removeIfPresent(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Cleanup must not mask the write or publication failure.
  }
}

function writeExclusiveText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let fd: number | undefined;
  let created = false;
  try {
    fd = fs.openSync(filePath, 'wx', 0o600);
    created = true;
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original failure.
      }
    }
    if (created) removeIfPresent(filePath);
    throw error;
  }
}

function publishDistinct(
  stagingPath: string,
  destinationPath: string,
  expectedDigest?: string,
  allowExistingMatching = false,
): void {
  const acceptExisting = (): boolean => {
    if (!allowExistingMatching || expectedDigest === undefined || !fs.existsSync(destinationPath)) return false;
    return digest(fs.readFileSync(destinationPath)) === expectedDigest;
  };
  if (fs.existsSync(destinationPath)) {
    if (acceptExisting()) return;
    throw new Error(`Refusing to overwrite derived export: ${destinationPath}`);
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  try {
    fs.linkSync(stagingPath, destinationPath);
  } catch (error) {
    if (!isFileSystemError(error) || error.code !== 'EEXIST' || !acceptExisting()) throw error;
    return;
  }
  if (
    fs.existsSync(destinationPath) &&
    digest(fs.readFileSync(destinationPath)) !== expectedDigest &&
    expectedDigest !== undefined
  ) {
    throw new Error(`Published export does not match staged content: ${destinationPath}`);
  }
  fs.unlinkSync(stagingPath);
}

function sameState(left: ExportState, right: ExportState): boolean {
  return (
    left.version === right.version &&
    left.operation === right.operation &&
    left.phase === right.phase &&
    left.sourcePath === right.sourcePath &&
    left.destinationPath === right.destinationPath &&
    left.reportPath === right.reportPath &&
    left.sourceSha256 === right.sourceSha256 &&
    sameIdentity(left.sourceIdentity, right.sourceIdentity) &&
    left.destinationSha256 === right.destinationSha256 &&
    left.reportSha256 === right.reportSha256 &&
    left.stagingPath === right.stagingPath &&
    left.reportStagingPath === right.reportStagingPath
  );
}

function writeState(statePath: string, state: ExportState, expectedState?: ExportState): void {
  const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    writeExclusiveText(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
    temporaryCreated = true;
    if (expectedState === undefined) {
      publishDistinct(temporaryPath, statePath);
      temporaryCreated = false;
      return;
    }
    const currentState = parseState(statePath);
    if (currentState === undefined || !sameState(currentState, expectedState)) {
      throw new Error(`v3 export state changed during publication: ${statePath}`);
    }
    fs.renameSync(temporaryPath, statePath);
    temporaryCreated = false;
    fs.chmodSync(statePath, 0o600);
  } catch (error) {
    if (temporaryCreated) removeIfPresent(temporaryPath);
    throw error;
  }
}

function parseSourceIdentity(value: unknown): SourceIdentity {
  const record = asRecord(value);
  if (record === undefined) throw new Error('Invalid v3 export source identity');
  const number = (field: string): number => {
    const candidate = record[field];
    if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate < 0) {
      throw new Error(`Invalid v3 export source identity ${field}`);
    }
    return candidate;
  };
  const mtimeMs = record.mtimeMs;
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs) || mtimeMs < 0) {
    throw new Error('Invalid v3 export source identity mtimeMs');
  }
  return { device: number('device'), inode: number('inode'), size: number('size'), mtimeMs };
}

function requireHash(value: unknown, field: string): string {
  const hash = requireString(value, field);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid v3 export ${field}`);
  return hash;
}

function parseState(statePath: string): ExportState | undefined {
  if (!fs.existsSync(statePath)) return undefined;
  const record = asRecord(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  if (
    record?.version !== EXPORT_STATE_VERSION ||
    record.operation !== EXPORT_OPERATION ||
    typeof record.phase !== 'string' ||
    typeof record.sourcePath !== 'string' ||
    typeof record.destinationPath !== 'string' ||
    typeof record.reportPath !== 'string' ||
    typeof record.sourceSha256 !== 'string' ||
    typeof record.destinationSha256 !== 'string' ||
    typeof record.reportSha256 !== 'string' ||
    typeof record.stagingPath !== 'string' ||
    typeof record.reportStagingPath !== 'string'
  ) {
    throw new Error(`Invalid v3 export state: ${statePath}`);
  }
  if (record.phase !== 'staged' && record.phase !== 'published')
    throw new Error(`Invalid v3 export state phase: ${record.phase}`);
  return {
    version: 1,
    operation: EXPORT_OPERATION,
    phase: record.phase,
    sourcePath: record.sourcePath,
    destinationPath: record.destinationPath,
    reportPath: record.reportPath,
    sourceSha256: requireHash(record.sourceSha256, 'source checksum'),
    sourceIdentity: parseSourceIdentity(record.sourceIdentity),
    destinationSha256: requireHash(record.destinationSha256, 'destination checksum'),
    reportSha256: requireHash(record.reportSha256, 'report checksum'),
    stagingPath: record.stagingPath,
    reportStagingPath: record.reportStagingPath,
  };
}

function assertDistinctPaths(sourcePath: string, destinationPath: string, reportPath: string, statePath: string): void {
  const paths = [sourcePath, destinationPath, reportPath, statePath];
  if (new Set(paths).size !== paths.length) throw new Error('v3 export paths must be distinct');
  if (sourcePath === destinationPath || sourcePath === reportPath)
    throw new Error('v3 export cannot overwrite its source');
}

function assertNoSourceAliases(sourcePath: string, paths: readonly string[]): void {
  const source = fs.statSync(sourcePath);
  for (const candidate of paths) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.statSync(candidate);
    if (stat.dev === source.dev && stat.ino === source.ino) {
      throw new Error(`v3 export path aliases its source: ${candidate}`);
    }
  }
}

function assertStatePaths(sourcePath: string, state: ExportState): void {
  const paths = [sourcePath, state.destinationPath, state.reportPath, state.stagingPath, state.reportStagingPath];
  if (new Set(paths).size !== paths.length) throw new Error('Invalid v3 export state paths');
  assertNoSourceAliases(sourcePath, paths.slice(1));
}

async function exportWhileOwned(
  sourcePath: string,
  destinationPath: string,
  reportPath: string,
  statePath: string,
  lease: HistoryOwnershipLease,
): Promise<V3ExportResult> {
  await lease.assertQuiescent();
  const snapshot = readSourceSnapshot(sourcePath);
  assertNoSourceAliases(sourcePath, [destinationPath, reportPath, statePath]);
  const state = parseState(statePath);
  if (state !== undefined) {
    assertStatePaths(sourcePath, state);
    if (
      state.sourcePath !== sourcePath ||
      state.destinationPath !== destinationPath ||
      state.reportPath !== reportPath ||
      state.sourceSha256 !== snapshot.sourceSha256 ||
      !sameIdentity(state.sourceIdentity, snapshot.identity)
    ) {
      throw new Error('v3 export state does not match source');
    }
    if (state.phase === 'published') {
      if (!fs.existsSync(destinationPath) || !fs.existsSync(reportPath))
        throw new Error('Published v3 export is incomplete');
      if (digest(fs.readFileSync(destinationPath)) !== state.destinationSha256)
        throw new Error('Published v3 export was modified');
      if (digest(fs.readFileSync(reportPath)) !== state.reportSha256)
        throw new Error('Published v3 loss report was modified');
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as V3ExportLossReport;
      return {
        status: 'already-published',
        sourcePath,
        destinationPath,
        reportPath,
        statePath,
        sourceSha256: snapshot.sourceSha256,
        losses: report.losses,
      };
    }
  }

  if (state === undefined) {
    if (fs.existsSync(destinationPath) || fs.existsSync(reportPath)) {
      throw new Error('Refusing to overwrite an existing v3 export or loss report');
    }
    const parsed = readJsonLines(snapshot.content);
    const entryWrites = parsed.writes.filter((write): write is V4EntryWrite => write.kind === 'entry');
    const usageWrites = parsed.writes.filter((write): write is V4UsageWrite => write.kind === 'usage');
    const valueWrites = parsed.writes.filter((write): write is V4ValueWrite => write.kind === 'value');
    const listWrites = parsed.writes.filter((write): write is V4ListWrite => write.kind === 'list');
    const losses = [...parsed.losses];
    if (parsed.header.parentSessionId !== undefined) {
      losses.push({
        code: 'parent-session-id',
        detail: 'v4 parentSessionId has no v3 path representation',
        record: { parentSessionId: parsed.header.parentSessionId },
      });
    }
    const entryRecords = convertEntries(entryWrites, usageWrites, losses);
    const provenance = readMetadataProvenance(sourcePath, snapshot, parsed, entryRecords);
    const convertedValues = convertValues(
      snapshot.sourceSha256,
      valueWrites,
      new Set(entryRecords.map((entry) => requireString(entry.id, 'converted entry id'))),
      provenance,
      losses,
    );
    const records = [
      ...orderEntriesForMainTip([...entryRecords], convertedValues.mainTipId, losses),
      ...convertedValues.records,
    ];
    for (const write of listWrites) {
      losses.push({
        code: 'list-not-representable',
        detail: `List ${write.namespace}/${write.key} is not representable in v3`,
        record: write,
      });
    }
    const destinationContent = Buffer.from(serializeV3(parsed.header, records));
    const report: V3ExportLossReport = {
      version: 1,
      format: 'doompi-v4-to-v3-loss-report',
      sourcePath,
      sourceSha256: snapshot.sourceSha256,
      destinationPath,
      losses,
    };
    const reportContent = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    const stagedPath = `${destinationPath}.${process.pid}.${randomUUID()}.staging`;
    const reportStagingPath = `${reportPath}.${process.pid}.${randomUUID()}.staging`;
    let stagedCreated = false;
    let reportStagingCreated = false;
    try {
      writeExclusiveText(stagedPath, destinationContent.toString('utf8'));
      stagedCreated = true;
      writeExclusiveText(reportStagingPath, reportContent.toString('utf8'));
      reportStagingCreated = true;
    } catch (error) {
      if (stagedCreated) removeIfPresent(stagedPath);
      if (reportStagingCreated) removeIfPresent(reportStagingPath);
      throw error;
    }
    const nextState: ExportState = {
      version: EXPORT_STATE_VERSION,
      operation: EXPORT_OPERATION,
      phase: 'staged',
      sourcePath,
      destinationPath,
      reportPath,
      sourceSha256: snapshot.sourceSha256,
      sourceIdentity: snapshot.identity,
      destinationSha256: digest(destinationContent),
      reportSha256: digest(reportContent),
      stagingPath: stagedPath,
      reportStagingPath,
    };
    try {
      writeState(statePath, nextState);
    } catch (error) {
      if (stagedCreated) removeIfPresent(stagedPath);
      if (reportStagingCreated) removeIfPresent(reportStagingPath);
      throw error;
    }
    await lease.assertQuiescent();
    assertSourceUnchanged(sourcePath, snapshot);
    publishDistinct(stagedPath, destinationPath, nextState.destinationSha256);
    await lease.assertQuiescent();
    assertSourceUnchanged(sourcePath, snapshot);
    publishDistinct(reportStagingPath, reportPath, nextState.reportSha256);
    await lease.assertQuiescent();
    assertSourceUnchanged(sourcePath, snapshot);
    writeState(statePath, { ...nextState, phase: 'published' }, nextState);
    return {
      status: 'published',
      sourcePath,
      destinationPath,
      reportPath,
      statePath,
      sourceSha256: snapshot.sourceSha256,
      losses,
    };
  }

  await lease.assertQuiescent();
  assertSourceUnchanged(sourcePath, snapshot);
  if (!fs.existsSync(destinationPath)) {
    if (!fs.existsSync(state.stagingPath)) throw new Error('Interrupted v3 export is missing its staged export');
    publishDistinct(state.stagingPath, destinationPath, state.destinationSha256, true);
  } else if (digest(fs.readFileSync(destinationPath)) !== state.destinationSha256) {
    throw new Error('Existing v3 export does not match interrupted state');
  }
  await lease.assertQuiescent();
  assertSourceUnchanged(sourcePath, snapshot);
  if (!fs.existsSync(reportPath)) {
    if (!fs.existsSync(state.reportStagingPath))
      throw new Error('Interrupted v3 export is missing its staged loss report');
    publishDistinct(state.reportStagingPath, reportPath, state.reportSha256, true);
  } else if (digest(fs.readFileSync(reportPath)) !== state.reportSha256) {
    throw new Error('Existing v3 loss report does not match interrupted state');
  }
  await lease.assertQuiescent();
  assertSourceUnchanged(sourcePath, snapshot);
  writeState(statePath, { ...state, phase: 'published' }, state);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as V3ExportLossReport;
  return {
    status: 'published',
    sourcePath,
    destinationPath,
    reportPath,
    statePath,
    sourceSha256: snapshot.sourceSha256,
    losses: report.losses,
  };
}

export async function exportV4ToV3(options: V3ExportOptions): Promise<V3ExportResult> {
  const sourcePath = path.resolve(options.sourcePath);
  const destinationPath = path.resolve(options.destinationPath);
  const reportPath = path.resolve(options.reportPath ?? `${destinationPath}.loss.json`);
  const statePath = path.resolve(options.statePath ?? `${destinationPath}.export-state.json`);
  assertDistinctPaths(sourcePath, destinationPath, reportPath, statePath);
  const lease = await options.owner.acquire(sourcePath);
  let result: V3ExportResult;
  try {
    result = await exportWhileOwned(sourcePath, destinationPath, reportPath, statePath, lease);
  } catch (error) {
    try {
      await lease.release();
    } catch {
      // Preserve the export failure.
    }
    throw error;
  }
  await lease.release();
  return result;
}
