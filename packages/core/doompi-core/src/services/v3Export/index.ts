import type { HistoryOwnership } from '../historyImport';

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

/** Retained legacy entrypoint; durable histories have no v3 export adapter. */
export async function exportV4ToV3(_options: V3ExportOptions): Promise<V3ExportResult> {
  throw new Error('Legacy history export is unsupported by fresh durable storage');
}
