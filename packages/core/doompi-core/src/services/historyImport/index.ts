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
  verifyStaging?: (stagingPath: string, proof: HistoryImportVerification) => Promise<HistoryImportVerification>;
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

/** Retained legacy entrypoints, fresh durable histories are never backed up or migrated. */
export async function preserveHistoryBeforeOpen(_sourcePath: string, _lease: HistoryOwnershipLease): Promise<string> {
  throw new Error('Legacy history backups are unsupported by fresh durable storage');
}
export async function protectAndImportHistory(_options: HistoryImportOptions): Promise<ProtectedHistoryImportResult> {
  throw new Error('Legacy history import is unsupported by fresh durable storage');
}
export async function restoreProtectedHistory(_options: RestoreProtectedHistoryOptions): Promise<void> {
  throw new Error('Legacy history restoration is unsupported by fresh durable storage');
}
