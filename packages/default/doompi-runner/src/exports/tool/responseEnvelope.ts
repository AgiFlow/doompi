import type { RunnerRecord } from '../../types/runnerRegistry.ts';
import { formatRunnerLine as formatRunnerLinePure } from '../../services/bashResult.ts';
import { summarizeLog, truncateForResult } from '../../adapters/LogReader/LogReader.ts';

export * from '../../services/bashResult.ts';
export { summarizeLog, truncateForResult };

export function formatRunnerLine(record: RunnerRecord, now = Date.now()): string {
  return formatRunnerLinePure(record, now);
}
