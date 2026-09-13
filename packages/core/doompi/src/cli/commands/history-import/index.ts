import fs from 'node:fs';
import path from 'node:path';

import { protectAndImportHistory, type HistoryOwnership } from '@agimon-ai/doompi-core/history-import';
import { createHistoryOwnership } from '@agimon-ai/doompi-core/history-ownership';
import { importV3WithPinnedUpstream } from '@agimon-ai/doompi-core/jsonl-session-repo';
import { importSqliteHistory, verifySqliteHistory } from '@agimon-ai/doompi-core/sqlite-history-import';

import { wantsHelp } from '../../router';
import { historyImportHelp } from './help';

interface HistoryImportPaths {
  sourcePath: string;
  destinationPath: string;
  format: 'jsonl' | 'sqlite';
}

export interface HistoryImportOutput {
  write(chunk: string): void;
}

function parsePaths(args: readonly string[], currentDirectory: string): HistoryImportPaths {
  const positional: string[] = [];
  let confirmed = false;
  let format: 'jsonl' | 'sqlite' = 'jsonl';

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--format') {
      if (format === 'sqlite') throw new Error('--format was specified more than once');
      const next = args[++index];
      if (next !== 'sqlite') throw new Error('history-import --format supports sqlite');
      format = next;
      continue;
    }
    if (argument === '--') throw new Error('doompi history-import does not accept passthrough arguments');
    if (argument === '--confirm-offline') {
      if (confirmed) throw new Error('--confirm-offline was specified more than once');
      confirmed = true;
      continue;
    }
    if (argument.startsWith('-')) throw new Error(`doompi history-import does not accept ${argument}`);
    positional.push(argument);
  }

  if (!confirmed) throw new Error('doompi history-import requires --confirm-offline after stopping Pi');
  if (positional.length !== 2) {
    throw new Error('doompi history-import requires a v3 source and distinct v4 destination');
  }

  const sourcePath = path.resolve(currentDirectory, positional[0]!);
  const destinationPath = path.resolve(currentDirectory, positional[1]!);
  if (sourcePath === destinationPath) throw new Error('Protected history destination must differ from source');
  return { sourcePath, destinationPath, format };
}

/** Imports one explicitly confirmed v3 journal without starting Pi or the harness. */
export async function runHistoryImport(
  args: readonly string[],
  _environment: NodeJS.ProcessEnv = process.env,
  currentDirectory = process.cwd(),
  output: HistoryImportOutput = process.stdout,
  owner?: HistoryOwnership,
): Promise<number> {
  if (wantsHelp(args.slice(1))) {
    output.write(historyImportHelp());
    return 0;
  }

  const paths = parsePaths(args.slice(1), currentDirectory);
  const header =
    paths.format === 'sqlite'
      ? (JSON.parse(fs.readFileSync(paths.sourcePath, 'utf8').split('\n', 1)[0]!) as { v?: number })
      : undefined;
  const result = await protectAndImportHistory({
    sourcePath: paths.sourcePath,
    destinationPath: paths.destinationPath,
    owner:
      owner ??
      createHistoryOwnership({
        sourceFormat: header?.v === 4 ? 'v4' : 'v3',
        additionalPaths: [paths.destinationPath],
      }),
    importStaging: paths.format === 'sqlite' ? importSqliteHistory : importV3WithPinnedUpstream,
    ...(paths.format === 'sqlite' ? { verifyStaging: verifySqliteHistory } : {}),
  });
  output.write(
    `${JSON.stringify({
      status: result.status,
      sourcePath: result.sourceIdentity.path,
      originalPath: result.originalPath,
      destinationPath: result.destinationPath,
      statePath: result.statePath,
      entryCount: result.verification.entries.length,
      branchCount: result.verification.branches.length,
    })}\n`,
  );
  return 0;
}
