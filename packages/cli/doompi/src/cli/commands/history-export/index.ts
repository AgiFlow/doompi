import { wantsHelp } from '../../router';
import { historyExportHelp } from './help';

export interface HistoryExportOutput {
  write(chunk: string): void;
}

/** Retained command entry point. Legacy history conversion is unsupported. */
export async function runHistoryExport(
  args: readonly string[],
  _environment: NodeJS.ProcessEnv = process.env,
  _currentDirectory = process.cwd(),
  output: HistoryExportOutput = process.stdout,
  _owner?: unknown,
): Promise<number> {
  if (wantsHelp(args.slice(1))) {
    output.write(historyExportHelp());
    return 0;
  }
  throw new Error('doompi history-export is unsupported in Pi 1.0. Legacy history conversion is not available.');
}
