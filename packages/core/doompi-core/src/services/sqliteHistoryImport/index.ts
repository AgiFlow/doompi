import type { HistoryImportVerification, HistoryStagingImportInput } from '../historyImport';

export async function importSqliteHistory(_input: HistoryStagingImportInput): Promise<HistoryImportVerification> {
  throw new Error('Legacy history import is unsupported by fresh durable storage');
}
export async function verifySqliteHistory(
  _stagingPath: string,
  _proof: HistoryImportVerification,
): Promise<HistoryImportVerification> {
  throw new Error('Legacy history verification is unsupported by fresh durable storage');
}
