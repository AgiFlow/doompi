import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './json';
import { importV3WithPinnedUpstream } from './jsonlSessionRepo';

export interface HistoryOwnershipLease {
  assertQuiescent(): void | Promise<void>;
  release(): void | Promise<void>;
}

/**
 * The caller must establish ownership and stop all managed writers before this
 * adapter reads or publishes a session. A filesystem lock cannot prove that an
 * unmanaged Pi process has stopped, so the boundary stays explicit.
 */
export interface HistoryOwnership {
  acquire(sourcePath: string): HistoryOwnershipLease | Promise<HistoryOwnershipLease>;
}

export interface HistoryEntryProof {
  sourceId: string;
  importedId: string;
  sourceParentId: string | null;
  importedParentId: string | null;
  sourceContentHash: string;
  importedContentHash: string;
}

export interface HistoryBranchProof {
  sourceTipId: string | null;
  importedTipId: string | null;
  branch?: string;
}

export interface HistoryImportVerification {
  entries: readonly HistoryEntryProof[];
  branches: readonly HistoryBranchProof[];
  /** Source records projected into upstream values rather than physical entries. */
  projectedSourceIds?: readonly string[];
}

export interface HistorySourceIdentity {
  path: string;
  realPath: string;
  device: number;
  inode: number;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface HistoryStagingImportInput {
  sourcePath: string;
  stagingPath: string;
  originalPath: string;
  sourceIdentity: HistorySourceIdentity;
}

export interface HistoryImportOptions {
  sourcePath: string;
  destinationPath: string;
  owner: HistoryOwnership;
  importStaging?: (input: HistoryStagingImportInput) => HistoryImportVerification | Promise<HistoryImportVerification>;
  originalPath?: string;
  statePath?: string;
}

export interface ProtectedHistoryImportResult {
  status: 'published' | 'already-published';
  sourceIdentity: HistorySourceIdentity;
  originalPath: string;
  destinationPath: string;
  statePath: string;
  verification: HistoryImportVerification;
  stagedSha256: string;
}

export interface RestoreProtectedHistoryOptions {
  sourcePath: string;
  originalPath: string;
  owner: HistoryOwnership;
}

interface ImportState {
  version: 1;
  operation: 'protected-history-import';
  phase: 'prepared' | 'staged' | 'verified' | 'published';
  sourcePath: string;
  destinationPath: string;
  originalPath: string;
  stagingPath: string;
  sourceIdentity: HistorySourceIdentity;
  verification?: HistoryImportVerification;
  stagedSha256?: string;
}

const IMPORT_STATE_VERSION = 1;
const IMPORT_OPERATION = 'protected-history-import';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid history import ${field}`);
  return value;
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== 'string') throw new Error(`Invalid history import ${field}`);
  return value;
}

function requireHash(value: unknown, field: string): string {
  const hash = requireString(value, field);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid history import ${field}`);
  return hash;
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function readSource(sourcePath: string): { content: Buffer; identity: HistorySourceIdentity } {
  const before = fs.statSync(sourcePath);
  const content = fs.readFileSync(sourcePath);
  const after = fs.statSync(sourcePath);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    after.size !== content.byteLength
  ) {
    throw new Error('Protected history source changed while it was being read');
  }
  return {
    content,
    identity: {
      path: path.resolve(sourcePath),
      realPath: fs.realpathSync(sourcePath),
      device: after.dev,
      inode: after.ino,
      size: after.size,
      mtimeMs: after.mtimeMs,
      sha256: sha256(content),
    },
  };
}

function sameIdentity(left: HistorySourceIdentity, right: HistorySourceIdentity): boolean {
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

function ensureOwnerOnly(filePath: string): void {
  fs.chmodSync(filePath, 0o600);
}

function writeExclusive(filePath: string, content: Uint8Array): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      fs.closeSync(fd);
      fs.rmSync(filePath, { force: true });
    }
    throw error;
  }
  fs.closeSync(fd);
  ensureOwnerOnly(filePath);
  const directoryFd = fs.openSync(path.dirname(filePath), 'r');
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}

function ensureOriginal(originalPath: string, content: Uint8Array): void {
  if (fs.existsSync(originalPath)) {
    const stat = fs.lstatSync(originalPath);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error(`Protected history original must be an independent file: ${originalPath}`);
    const existing = fs.readFileSync(originalPath);
    if (sha256(existing) !== sha256(content)) throw new Error(`Protected history original differs: ${originalPath}`);
    ensureOwnerOnly(originalPath);
    return;
  }
  try {
    writeExclusive(originalPath, content);
  } catch (error) {
    if (!isFileSystemError(error) || error.code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(originalPath);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error(`Protected history original must be an independent file: ${originalPath}`);
    const existing = fs.readFileSync(originalPath);
    if (sha256(existing) !== sha256(content)) throw new Error(`Protected history original differs: ${originalPath}`);
    ensureOwnerOnly(originalPath);
  }
}

/** Preserve exact bytes before upstream open is allowed to repair a native journal. */
export async function preserveHistoryBeforeOpen(sourcePath: string, lease: HistoryOwnershipLease): Promise<string> {
  await lease.assertQuiescent();
  const source = readSource(sourcePath);
  const originalPath = `${source.identity.realPath}.recovery-${source.identity.sha256}.original`;
  ensureOriginal(originalPath, source.content);
  const recordPath = `${originalPath}.json`;
  if (!fs.existsSync(recordPath)) {
    writeExclusive(
      recordPath,
      Buffer.from(`${JSON.stringify({ version: 1, source: source.identity, originalPath })}\n`),
    );
  } else {
    const record = asRecord(JSON.parse(fs.readFileSync(recordPath, 'utf8')));
    const identity = asRecord(record?.source);
    if (
      record?.originalPath !== originalPath ||
      identity?.sha256 !== source.identity.sha256 ||
      identity.realPath !== source.identity.realPath
    ) {
      throw new Error('Existing recovery provenance does not match the protected journal');
    }
  }
  await lease.assertQuiescent();
  if (!sameIdentity(source.identity, readSource(sourcePath).identity))
    throw new Error('Journal changed during recovery preservation');
  return originalPath;
}

function writeBinaryAtomically(filePath: string, content: Uint8Array): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeExclusive(temporaryPath, content);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function publishDistinct(stagingPath: string, destinationPath: string): void {
  if (fs.existsSync(destinationPath)) throw new Error(`Refusing to overwrite derived history: ${destinationPath}`);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.linkSync(stagingPath, destinationPath);
  fs.unlinkSync(stagingPath);
}

function writeState(statePath: string, state: ImportState): void {
  writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
  ensureOwnerOnly(statePath);
}

function readState(statePath: string): ImportState | undefined {
  if (!fs.existsSync(statePath)) return undefined;
  ensureOwnerOnly(statePath);
  const value = asRecord(JSON.parse(fs.readFileSync(statePath, 'utf8')));
  if (value?.version !== IMPORT_STATE_VERSION || value.operation !== IMPORT_OPERATION) {
    throw new Error(`Invalid protected history state: ${statePath}`);
  }
  const phase = value.phase;
  if (phase !== 'prepared' && phase !== 'staged' && phase !== 'verified' && phase !== 'published') {
    throw new Error(`Invalid protected history state phase: ${String(phase)}`);
  }
  const sourceIdentity = asRecord(value.sourceIdentity);
  const verification = value.verification === undefined ? undefined : parseVerification(value.verification);
  return {
    version: 1,
    operation: IMPORT_OPERATION,
    phase,
    sourcePath: requireString(value.sourcePath, 'state source path'),
    destinationPath: requireString(value.destinationPath, 'state destination path'),
    originalPath: requireString(value.originalPath, 'state original path'),
    stagingPath: requireString(value.stagingPath, 'state staging path'),
    sourceIdentity: parseSourceIdentity(sourceIdentity),
    verification,
    stagedSha256: value.stagedSha256 === undefined ? undefined : requireHash(value.stagedSha256, 'staged checksum'),
  };
}

function parseSourceIdentity(value: Record<string, unknown> | undefined): HistorySourceIdentity {
  if (value === undefined) throw new Error('Invalid protected history source identity');
  const numeric = (field: string): number => {
    const number = value[field];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0)
      throw new Error(`Invalid history import ${field}`);
    return number;
  };
  const mtimeMs = value.mtimeMs;
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs) || mtimeMs < 0) {
    throw new Error('Invalid history import mtimeMs');
  }
  return {
    path: requireString(value.path, 'source path'),
    realPath: requireString(value.realPath, 'source real path'),
    device: numeric('device'),
    inode: numeric('inode'),
    size: numeric('size'),
    mtimeMs,
    sha256: requireHash(value.sha256, 'source checksum'),
  };
}

function parseVerification(value: unknown): HistoryImportVerification {
  const record = asRecord(value);
  if (record === undefined || !Array.isArray(record.entries) || !Array.isArray(record.branches)) {
    throw new Error('Invalid protected history verification');
  }
  const entries = record.entries.map((entry, index) => {
    const item = asRecord(entry);
    if (item === undefined) throw new Error(`Invalid history entry proof at index ${index}`);
    return {
      sourceId: requireString(item.sourceId, 'entry source id'),
      importedId: requireString(item.importedId, 'entry imported id'),
      sourceParentId: requireNullableString(item.sourceParentId, 'entry source parent id'),
      importedParentId: requireNullableString(item.importedParentId, 'entry imported parent id'),
      sourceContentHash: requireHash(item.sourceContentHash, 'entry source content hash'),
      importedContentHash: requireHash(item.importedContentHash, 'entry imported content hash'),
    };
  });
  const branches = record.branches.map((branch, index) => {
    const item = asRecord(branch);
    if (item === undefined) throw new Error(`Invalid history branch proof at index ${index}`);
    const name = item.branch === undefined ? undefined : requireString(item.branch, `branch name at index ${index}`);
    return {
      sourceTipId: requireNullableString(item.sourceTipId, `branch source tip id at index ${index}`),
      importedTipId: requireNullableString(item.importedTipId, `branch imported tip id at index ${index}`),
      ...(name === undefined ? {} : { branch: name }),
    };
  });
  const projectedSourceIds = record.projectedSourceIds;
  if (
    projectedSourceIds !== undefined &&
    (!Array.isArray(projectedSourceIds) || projectedSourceIds.some((id) => typeof id !== 'string' || id.length === 0))
  ) {
    throw new Error('Invalid projected protected history source ids');
  }
  const projected = projectedSourceIds as string[] | undefined;
  if (projected !== undefined && new Set(projected).size !== projected.length) {
    throw new Error('Duplicate projected protected history source id');
  }
  return { entries, branches, ...(projected === undefined ? {} : { projectedSourceIds: projected }) };
}

interface ParsedHistory {
  header: Record<string, unknown>;
  labels: Map<string, unknown>;
  sessionName: unknown;
  records: Record<string, unknown>[];
  byId: Map<string, Record<string, unknown>>;
  branchTips: Map<string, string | null>;
}

function parseHistory(content: Uint8Array, expected: 'v3' | 'v4' | 'auto'): ParsedHistory {
  const text = Buffer.from(content).toString('utf8');
  if (Buffer.from(text).compare(Buffer.from(content)) !== 0 || !text.endsWith('\n')) {
    throw new Error('Protected history JSONL is truncated or not valid UTF-8');
  }
  const lines = text.slice(0, -1).split('\n');
  const first = lines[0];
  if (first === undefined || first.length === 0) throw new Error('Protected history is empty');
  const header = asRecord(JSON.parse(first));
  const actual =
    header?.type === 'session' && header.version === 3
      ? 'v3'
      : header?.kind === 'header' && header.v === 4
        ? 'v4'
        : undefined;
  if (actual === undefined || (expected !== 'auto' && actual !== expected)) {
    throw new Error(expected === 'v3' ? 'Protected history source is not v3' : 'Protected history staging is not v4');
  }
  const records: Record<string, unknown>[] = [];
  const byId = new Map<string, Record<string, unknown>>();
  const branchTips = new Map<string, string | null>();
  const labels = new Map<string, unknown>();
  let sessionName: unknown;
  for (const [index, line] of lines.slice(1).entries()) {
    if (line.length === 0) throw new Error(`Invalid protected history JSONL at line ${index + 2}`);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid protected history JSONL at line ${index + 2}`, { cause: error });
    }
    const values = actual === 'v4' && Array.isArray(value) ? value : [value];
    for (const item of values) {
      const record = asRecord(item);
      if (record === undefined) throw new Error(`Invalid protected history record at line ${index + 2}`);
      if (actual === 'v4') {
        if (record.kind === 'value' && typeof record.key === 'string') {
          if (record.namespace === 'pi.entry.label') {
            if (record.op === 'delete') labels.delete(record.key);
            else labels.set(record.key, record.value);
          } else if (record.namespace === 'pi.session.name' && record.key === '') {
            sessionName = record.op === 'delete' ? undefined : record.value;
          }
        }
        if (record.kind === 'entry') {
          const entry =
            asRecord(record.entry) ??
            (() => {
              const { kind: _kind, seq: _seq, ...flat } = record;
              return flat;
            })();
          records.push(entry);
          const id = requireString(entry.id, 'imported entry id');
          if (byId.has(id)) throw new Error(`Duplicate protected history entry id: ${id}`);
          byId.set(id, entry);
        } else if (record.kind === 'value' && record.namespace === 'pi.branch.tip' && typeof record.key === 'string') {
          const tip = record.op === 'delete' ? null : requireNullableString(record.value, 'imported branch tip');
          branchTips.set(record.key, tip);
        }
      } else {
        if (record.id === undefined) throw new Error(`Protected history record at line ${index + 2} has no id`);
        const id = requireString(record.id, 'source entry id');
        if (byId.has(id)) throw new Error(`Duplicate protected history entry id: ${id}`);
        records.push(record);
        byId.set(id, record);
      }
    }
  }
  return { header: header!, records, byId, branchTips, labels, sessionName };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = asRecord(value);
  if (record === undefined) return JSON.stringify(value);
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function contentHash(record: Record<string, unknown>): string {
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
  return sha256(Buffer.from(stableJson(content)));
}

function sourceParentId(record: Record<string, unknown>, field: string): string | null {
  return requireNullableString(record.parentId, field);
}

function resolveMappedParent(
  sourceId: string | null,
  source: ParsedHistory,
  mappings: Map<string, HistoryEntryProof>,
): string | null {
  const visited = new Set<string>();
  let current = sourceId;
  while (current !== null) {
    if (visited.has(current)) throw new Error(`Cycle in protected history parent chain: ${current}`);
    visited.add(current);
    const mapped = mappings.get(current);
    if (mapped !== undefined) return mapped.importedId;
    const parent = source.byId.get(current);
    if (parent === undefined) throw new Error(`Protected history parent references unknown entry: ${current}`);
    current = sourceParentId(parent, 'source parent id');
  }
  return null;
}

function historyTimestamp(value: unknown): number {
  const timestamp = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) throw new Error('Invalid protected history timestamp');
  return timestamp;
}

function verifyImport(
  sourceContent: Uint8Array,
  importedContent: Uint8Array,
  verification: HistoryImportVerification,
): HistoryImportVerification {
  const source = parseHistory(sourceContent, 'v3');
  const imported = parseHistory(importedContent, 'v4');
  if (
    imported.header.id !== requireString(source.header.id, 'session identity') ||
    imported.header.cwd !== requireString(source.header.cwd, 'session cwd identity') ||
    historyTimestamp(imported.header.createdAt) !== historyTimestamp(source.header.timestamp)
  ) {
    throw new Error('Imported history session identity mismatch');
  }
  const importedIds = new Set(imported.byId.keys());
  const mappedSourceIds = new Set<string>();
  const mappings = new Map<string, HistoryEntryProof>();
  for (const entry of verification.entries) {
    if (!source.byId.has(entry.sourceId))
      throw new Error(`Imported proof references unknown source entry: ${entry.sourceId}`);
    if (mappedSourceIds.has(entry.sourceId))
      throw new Error(`Duplicate imported source entry proof: ${entry.sourceId}`);
    if (mappings.has(entry.sourceId) || !importedIds.has(entry.importedId))
      throw new Error(`Imported proof references unknown imported entry: ${entry.importedId}`);
    if (entry.sourceContentHash !== entry.importedContentHash)
      throw new Error(`Imported history content mismatch: ${entry.sourceId}`);
    if (entry.sourceContentHash !== contentHash(source.byId.get(entry.sourceId)!))
      throw new Error(`Imported source content proof mismatch: ${entry.sourceId}`);
    if (entry.importedContentHash !== contentHash(imported.byId.get(entry.importedId)!))
      throw new Error(`Imported content proof mismatch: ${entry.importedId}`);
    mappedSourceIds.add(entry.sourceId);
    mappings.set(entry.sourceId, entry);
  }
  const projected = new Set(verification.projectedSourceIds ?? []);
  for (const id of projected) {
    if (!source.byId.has(id)) throw new Error(`Imported proof references unknown projected source entry: ${id}`);
  }
  for (const id of source.byId.keys()) {
    if (!mappedSourceIds.has(id) && !projected.has(id)) throw new Error(`Imported proof omits source entry: ${id}`);
    if (projected.has(id) && mappedSourceIds.has(id))
      throw new Error(`Imported proof maps and projects source entry: ${id}`);
    if (projected.has(id)) {
      const type = source.byId.get(id)?.type;
      if (
        type !== 'model_change' &&
        type !== 'thinking_level_change' &&
        type !== 'active_tools_change' &&
        type !== 'session_info' &&
        type !== 'label'
      ) {
        throw new Error(`Protected history cannot project source entry: ${id}`);
      }
    }
  }
  const importedProofIds = new Set<string>();
  for (const entry of verification.entries) {
    if (importedProofIds.has(entry.importedId)) throw new Error(`Duplicate imported entry proof: ${entry.importedId}`);
    importedProofIds.add(entry.importedId);
  }
  for (const id of imported.byId.keys()) {
    if (!importedProofIds.has(id)) throw new Error(`Imported proof omits imported entry: ${id}`);
  }
  for (const entry of verification.entries) {
    const sourceEntry = source.byId.get(entry.sourceId)!;
    const importedEntry = imported.byId.get(entry.importedId)!;
    if (historyTimestamp(sourceEntry.timestamp) !== historyTimestamp(importedEntry.timestamp)) {
      throw new Error(`Imported history timestamp mismatch: ${entry.sourceId}`);
    }
    if (entry.sourceParentId !== sourceParentId(sourceEntry, 'source parent id')) {
      throw new Error(`Imported source parent proof mismatch: ${entry.sourceId}`);
    }
    const expectedParent = resolveMappedParent(sourceParentId(sourceEntry, 'source parent id'), source, mappings);
    const actualParent = sourceParentId(importedEntry, 'imported parent id');
    if (expectedParent !== actualParent || entry.importedParentId !== actualParent)
      throw new Error(`Imported history parent mismatch: ${entry.sourceId}`);
  }
  const expectedLabels = new Map<string, unknown>();
  for (const record of source.records) {
    if (record.type !== 'label') continue;
    const target = resolveMappedParent(requireString(record.targetId, 'label target'), source, mappings);
    if (target === null) continue;
    if (record.label) expectedLabels.set(target, record.label);
    else expectedLabels.delete(target);
  }
  if (
    expectedLabels.size !== imported.labels.size ||
    [...expectedLabels].some(([id, label]) => imported.labels.get(id) !== label)
  ) {
    throw new Error('Imported history label projection mismatch');
  }
  const expectedName = source.records.findLast((record) => record.type === 'session_info')?.name || undefined;
  if (imported.sessionName !== expectedName) throw new Error('Imported history session name projection mismatch');
  const selectedSourceId = source.records.at(-1)?.id;
  const expectedMainTip = resolveMappedParent(
    selectedSourceId === undefined ? null : requireString(selectedSourceId, 'selected source id'),
    source,
    mappings,
  );
  if (imported.branchTips.get('main') !== expectedMainTip) {
    throw new Error('Imported history selected branch mismatch');
  }
  const seenBranches = new Set<string>();
  for (const branch of verification.branches) {
    const branchKey = branch.branch ?? `#${seenBranches.size}`;
    if (seenBranches.has(branchKey)) throw new Error(`Duplicate imported history branch proof: ${branchKey}`);
    seenBranches.add(branchKey);
    if (branch.sourceTipId === null || branch.importedTipId === null) {
      if (branch.sourceTipId !== branch.importedTipId) throw new Error('Imported history branch root mismatch');
    } else {
      const mapping = mappings.get(branch.sourceTipId);
      if (mapping === undefined || mapping.importedId !== branch.importedTipId)
        throw new Error(`Imported history branch mismatch: ${branch.sourceTipId}`);
    }
    if (branch.branch !== undefined && imported.branchTips.get(branch.branch) !== branch.importedTipId) {
      throw new Error(`Imported history branch tip mismatch: ${branch.branch}`);
    }
  }
  for (const [branch, tip] of imported.branchTips) {
    const proof = verification.branches.find((item) => item.branch === branch);
    if (proof === undefined || proof.importedTipId !== tip) throw new Error(`Imported proof omits branch: ${branch}`);
  }
  return verification;
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

function assertPaths(options: HistoryImportOptions, originalPath: string, statePath: string): void {
  const sourcePath = path.resolve(options.sourcePath);
  const destinationPath = path.resolve(options.destinationPath);
  if (sourcePath === destinationPath) throw new Error('Protected history destination must differ from source');
  if (sourcePath === path.resolve(originalPath) || sourcePath === path.resolve(statePath)) {
    throw new Error('Protected history sidecars must differ from source');
  }
  if (destinationPath === path.resolve(originalPath) || destinationPath === path.resolve(statePath)) {
    throw new Error('Protected history destination must differ from sidecars');
  }
}

export async function protectAndImportHistory(options: HistoryImportOptions): Promise<ProtectedHistoryImportResult> {
  const sourcePath = path.resolve(options.sourcePath);
  const destinationPath = path.resolve(options.destinationPath);
  const originalPath = path.resolve(options.originalPath ?? `${sourcePath}.original`);
  const statePath = path.resolve(options.statePath ?? `${destinationPath}.import-state.json`);
  assertPaths(options, originalPath, statePath);

  const lease = await options.owner.acquire(sourcePath);
  try {
    await lease.assertQuiescent();
    const source = readSource(sourcePath);
    const existingState = readState(statePath);
    if (existingState !== undefined) {
      if (
        existingState.sourcePath !== source.identity.path ||
        existingState.destinationPath !== destinationPath ||
        existingState.originalPath !== originalPath ||
        !sameIdentity(existingState.sourceIdentity, source.identity)
      ) {
        throw new Error('Protected history state does not match current source');
      }
      ensureOriginal(originalPath, source.content);
      if (existingState.phase === 'published') {
        if (!fs.existsSync(destinationPath)) throw new Error('Published protected history is missing its destination');
        if (existingState.stagedSha256 === undefined)
          throw new Error('Published protected history has no destination checksum');
        if (sha256(fs.readFileSync(destinationPath)) !== existingState.stagedSha256) {
          throw new Error('Published protected history destination was modified');
        }
        if (existingState.verification === undefined)
          throw new Error('Published protected history has no verification proof');
        return {
          status: 'already-published',
          sourceIdentity: source.identity,
          originalPath,
          destinationPath,
          statePath,
          verification: existingState.verification,
          stagedSha256: existingState.stagedSha256,
        };
      }
    } else {
      ensureOriginal(originalPath, source.content);
    }

    let state: ImportState;
    if (existingState === undefined) {
      state = {
        version: IMPORT_STATE_VERSION,
        operation: IMPORT_OPERATION,
        phase: 'prepared',
        sourcePath: source.identity.path,
        destinationPath,
        originalPath,
        stagingPath: `${destinationPath}.${process.pid}.${randomUUID()}.staging`,
        sourceIdentity: source.identity,
      };
      writeState(statePath, state);
    } else {
      state = existingState;
    }

    if (fs.existsSync(destinationPath)) {
      const stagedSha256 = state.stagedSha256;
      if (stagedSha256 !== undefined && sha256(fs.readFileSync(destinationPath)) === stagedSha256) {
        state = { ...state, phase: 'published' };
        writeState(statePath, state);
        return {
          status: 'already-published',
          sourceIdentity: source.identity,
          originalPath,
          destinationPath,
          statePath,
          verification: state.verification ?? { entries: [], branches: [] },
          stagedSha256,
        };
      }
      throw new Error(`Refusing to overwrite derived history: ${destinationPath}`);
    }

    if (state.phase === 'prepared') {
      if (fs.existsSync(state.stagingPath)) fs.rmSync(state.stagingPath, { force: true });
      fs.copyFileSync(originalPath, state.stagingPath, fs.constants.COPYFILE_EXCL);
      ensureOwnerOnly(state.stagingPath);
      const importedVerification = await (options.importStaging ?? importV3WithPinnedUpstream)({
        sourcePath,
        stagingPath: state.stagingPath,
        originalPath,
        sourceIdentity: source.identity,
      });
      state = {
        ...state,
        phase: 'staged',
        verification: importedVerification,
        stagedSha256: sha256(fs.readFileSync(state.stagingPath)),
      };
      writeState(statePath, state);
    }
    if (state.verification === undefined) throw new Error('Protected history staging has no verification proof');
    const verification = state.verification;
    if (state.phase === 'staged') {
      state = {
        ...state,
        phase: 'verified',
        verification: verifyImport(source.content, fs.readFileSync(state.stagingPath), verification),
      };
      writeState(statePath, state);
    }
    await lease.assertQuiescent();
    const current = readSource(sourcePath);
    if (!sameIdentity(current.identity, source.identity))
      throw new Error('Protected history source changed during import');
    if (!fs.existsSync(state.stagingPath)) throw new Error('Protected history staging copy is missing');
    if (state.stagedSha256 !== undefined && sha256(fs.readFileSync(state.stagingPath)) !== state.stagedSha256) {
      throw new Error('Protected history staging copy changed during import');
    }
    publishDistinct(state.stagingPath, destinationPath);
    state = { ...state, phase: 'published' };
    writeState(statePath, state);
    return {
      status: 'published',
      sourceIdentity: source.identity,
      originalPath,
      destinationPath,
      statePath,
      verification,
      stagedSha256: state.stagedSha256 ?? sha256(fs.readFileSync(destinationPath)),
    };
  } finally {
    await lease.release();
  }
}

export async function restoreProtectedHistory(options: RestoreProtectedHistoryOptions): Promise<void> {
  const sourcePath = path.resolve(options.sourcePath);
  const originalPath = path.resolve(options.originalPath);
  const lease = await options.owner.acquire(sourcePath);
  try {
    await lease.assertQuiescent();
    const original = fs.readFileSync(originalPath);
    const current = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath) : undefined;
    if (current !== undefined && sha256(current) === sha256(original)) return;
    writeBinaryAtomically(sourcePath, original);
    ensureOwnerOnly(sourcePath);
  } finally {
    await lease.release();
  }
}
