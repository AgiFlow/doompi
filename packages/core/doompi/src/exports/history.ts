/** Public history ownership, protected offline v3 import, and derived v3 export APIs. */
export {
  createHistoryOwnership,
  createV4HistoryOwnership,
  historyOwnershipLockPath,
} from '../adapters/serialization/historyOwnership.ts';
export type { HistoryOwnershipOptions } from '../adapters/serialization/historyOwnership.ts';
export { importV3WithPinnedUpstream } from '../adapters/serialization/jsonlSessionRepo.ts';
export { protectAndImportHistory } from '../adapters/serialization/historyImport.ts';
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
} from '../adapters/serialization/historyImport.ts';
export { exportV4ToV3 } from '../adapters/serialization/v3Export.ts';
export type {
  V3ExportLoss,
  V3ExportLossReport,
  V3ExportOptions,
  V3ExportResult,
} from '../adapters/serialization/v3Export.ts';
