/**
 * Result values delivered by the typed external runner channel.
 *
 * Durable result files remain an explicit history artifact. Live completion
 * delivery is owned by ExternalProcessIpc and never scans or watches them.
 */
export const RESULT_FILE_SUFFIX = '.json';
export const CLAIMED_RESULT_FILE_NAME = 'claimed-result.json';

export interface RunResultFile {
  runId: string;
  [key: string]: unknown;
}
