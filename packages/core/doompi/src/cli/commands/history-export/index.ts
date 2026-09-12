import path from 'node:path';
import { createHistoryOwnership } from '@agimon-ai/doompi-core/history-ownership';
import { exportV4ToV3 } from '@agimon-ai/doompi-core/v3-export';
import type { HistoryOwnership } from '@agimon-ai/doompi-core/history-import';
import { historyExportHelp } from './help';
import { wantsHelp } from '../../router';

type ValueOption =
  | '--source'
  | '--source-path'
  | '--destination'
  | '--destination-path'
  | '--report'
  | '--report-path'
  | '--state'
  | '--state-path';
const VALUE_OPTIONS = new Map<ValueOption, keyof HistoryExportPaths>([
  ['--source', 'sourcePath'],
  ['--source-path', 'sourcePath'],
  ['--destination', 'destinationPath'],
  ['--destination-path', 'destinationPath'],
  ['--report', 'reportPath'],
  ['--report-path', 'reportPath'],
  ['--state', 'statePath'],
  ['--state-path', 'statePath'],
]);

type HistoryExportPaths = {
  sourcePath?: string;
  destinationPath?: string;
  reportPath?: string;
  statePath?: string;
};

export interface HistoryExportOutput {
  write(chunk: string): void;
}

function parsePaths(args: readonly string[], currentDirectory: string): HistoryExportPaths {
  const paths: HistoryExportPaths = {};
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--') throw new Error('doompi history-export does not accept passthrough arguments');
    const equals = argument.indexOf('=');
    const option = equals < 0 ? argument : argument.slice(0, equals);
    const key = VALUE_OPTIONS.get(option as ValueOption);
    if (key !== undefined) {
      const value = equals < 0 ? args[++index] : argument.slice(equals + 1);
      if (!value) throw new Error(`${option} requires a value`);
      if (paths[key] !== undefined) throw new Error(`${option} was specified more than once`);
      paths[key] = value;
      continue;
    }
    if (argument.startsWith('-')) throw new Error(`doompi history-export does not accept ${argument}`);
    positional.push(argument);
  }
  if (paths.sourcePath === undefined) paths.sourcePath = positional.shift();
  if (paths.destinationPath === undefined) paths.destinationPath = positional.shift();
  if (positional.length > 0) throw new Error(`Unexpected history-export argument: ${positional[0]}`);
  if (paths.sourcePath === undefined || paths.destinationPath === undefined) {
    throw new Error('doompi history-export requires a v4 source and distinct v3 destination');
  }
  return {
    sourcePath: path.resolve(currentDirectory, paths.sourcePath),
    destinationPath: path.resolve(currentDirectory, paths.destinationPath),
    ...(paths.reportPath === undefined ? {} : { reportPath: path.resolve(currentDirectory, paths.reportPath) }),
    ...(paths.statePath === undefined ? {} : { statePath: path.resolve(currentDirectory, paths.statePath) }),
  };
}

/** Exports one canonical v4 journal without starting the harness or Pi runtime. */
export async function runHistoryExport(
  args: readonly string[],
  _environment: NodeJS.ProcessEnv = process.env,
  currentDirectory = process.cwd(),
  output: HistoryExportOutput = process.stdout,
  owner: HistoryOwnership = createHistoryOwnership(),
): Promise<number> {
  if (wantsHelp(args.slice(1))) {
    output.write(historyExportHelp());
    return 0;
  }
  const paths = parsePaths(args.slice(1), currentDirectory);
  const result = await exportV4ToV3({
    sourcePath: paths.sourcePath!,
    destinationPath: paths.destinationPath!,
    owner,
    ...(paths.reportPath === undefined ? {} : { reportPath: paths.reportPath }),
    ...(paths.statePath === undefined ? {} : { statePath: paths.statePath }),
  });
  output.write(
    `${JSON.stringify({
      status: result.status,
      sourcePath: result.sourcePath,
      destinationPath: result.destinationPath,
      reportPath: result.reportPath,
      statePath: result.statePath,
      lossCount: result.losses.length,
    })}\n`,
  );
  return 0;
}
