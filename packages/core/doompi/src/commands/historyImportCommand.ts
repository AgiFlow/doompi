import path from 'node:path';
import { createHistoryOwnership } from '../adapters/serialization/historyOwnership.ts';
import { protectAndImportHistory, type HistoryOwnership } from '../adapters/serialization/historyImport.ts';
import { importV3WithPinnedUpstream } from '../adapters/serialization/jsonlSessionRepo.ts';
import { historyImportHelp } from './cli/help.ts';
import { wantsHelp } from './cli/router.ts';

const COMMAND = 'history-import';

interface HistoryImportPaths {
  sourcePath: string;
  destinationPath: string;
}

export interface HistoryImportCommandOptions {
  owner?: HistoryOwnership;
}

export interface HistoryImportOutput {
  write(chunk: string): void;
}

function parsePaths(args: readonly string[], currentDirectory: string): HistoryImportPaths {
  const positional: string[] = [];
  let confirmed = false;

  for (const argument of args) {
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
  return { sourcePath, destinationPath };
}

/** Imports one explicitly confirmed v3 journal without starting Pi or the harness. */
export class HistoryImportCommand {
  readonly name = COMMAND;
  private readonly owner?: HistoryOwnership;

  constructor(options: HistoryImportCommandOptions = {}) {
    this.owner = options.owner;
  }

  matches(args: readonly string[]): boolean {
    return args[0] === this.name;
  }

  async execute(
    args: readonly string[],
    _environment: NodeJS.ProcessEnv = process.env,
    currentDirectory = process.cwd(),
    output: HistoryImportOutput = process.stdout,
  ): Promise<number> {
    if (wantsHelp(args.slice(1))) {
      output.write(historyImportHelp());
      return 0;
    }

    const paths = parsePaths(args.slice(1), currentDirectory);
    const result = await protectAndImportHistory({
      sourcePath: paths.sourcePath,
      destinationPath: paths.destinationPath,
      owner:
        this.owner ??
        createHistoryOwnership({
          sourceFormat: 'v3',
          additionalPaths: [paths.destinationPath],
        }),
      importStaging: importV3WithPinnedUpstream,
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
}
