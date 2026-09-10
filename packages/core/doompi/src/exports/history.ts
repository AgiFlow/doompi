/** Public canonical-v4 history ownership and derived v3 export APIs. */
export {
  createHistoryOwnership,
  createV4HistoryOwnership,
  historyOwnershipLockPath,
} from '../adapters/serialization/historyOwnership.ts';
export type { HistoryOwnershipOptions } from '../adapters/serialization/historyOwnership.ts';
export { exportV4ToV3 } from '../adapters/serialization/v3Export.ts';
export type {
  V3ExportLoss,
  V3ExportLossReport,
  V3ExportOptions,
  V3ExportResult,
} from '../adapters/serialization/v3Export.ts';
export type { HistoryOwnership, HistoryOwnershipLease } from '../adapters/serialization/historyImport.ts';
