import { wantsHelp } from '../../router';
import { historyImportHelp } from './help';

export interface HistoryImportOutput {
  write(chunk: string): void;
}

/** Retained command entry point. Legacy history conversion is unsupported. */
export async function runHistoryImport(
  args: readonly string[],
  _environment: NodeJS.ProcessEnv = process.env,
  _currentDirectory = process.cwd(),
  output: HistoryImportOutput = process.stdout,
  _owner?: unknown,
): Promise<number> {
  if (wantsHelp(args.slice(1))) {
    output.write(historyImportHelp());
    return 0;
  }
  throw new Error('doompi history-import is unsupported in Pi 1.0. Legacy history conversion is not available.');
}
