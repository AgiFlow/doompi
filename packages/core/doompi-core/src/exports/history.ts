/** Public history ownership, protected offline v3 import, and derived v3 export APIs. */
export {
  createHistoryOwnership,
  createV4HistoryOwnership,
  historyOwnershipLockPath,
} from '../services/historyOwnership';
export type { HistoryOwnershipOptions } from '../services/historyOwnership';
export { importV3WithPinnedUpstream } from '../services/jsonlSessionRepo';
export { protectAndImportHistory } from '../services/historyImport';
export type {
  HistoryBranchProof,
  HistoryEntryProof,
  HistoryImportOptions,
  HistoryImportVerification,
  HistoryOwnership,
  HistoryOwnershipLease,
  HistorySourceIdentity,
  HistoryStagingImportInput,
  ProtectedHistoryImportResult,
} from '../services/historyImport';
export { exportV4ToV3 } from '../services/v3Export';
export { listSavedSessions } from '../services/sqliteSessionHistory';
export type { SavedSession } from '../services/sqliteSessionHistory';
export type { V3ExportLoss, V3ExportLossReport, V3ExportOptions, V3ExportResult } from '../services/v3Export';
