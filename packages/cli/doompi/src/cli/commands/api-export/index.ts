import os from 'node:os';
import path from 'node:path';

import { exportApiContracts } from '../../../builders/apiContractExport';
import { wantsHelp } from '../../router';

export function apiExportHelp(): string {
  return `Usage: doompi api-export --out <directory> [--major-mode <name>] [--strict]

Export OpenAPI, AsyncAPI, and a coverage manifest from synced global and workspace
API generations. No packages are installed and no services are started.

  --out <directory>     Destination for openapi.json, asyncapi.json, manifest.json
  --major-mode <name>   Session mode (defaults to the workspace default)
  --strict              Exit nonzero when selected contract coverage is incomplete
  -h, --help            Show this help
`;
}

export async function runApiExport(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  output: { write(chunk: string): void } = process.stdout,
): Promise<number> {
  if (wantsHelp(args.slice(1))) {
    output.write(apiExportHelp());
    return 0;
  }
  let destination: string | undefined;
  let majorMode: string | undefined;
  let strict = false;
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--strict') {
      strict = true;
      continue;
    }
    if (option !== '--out' && option !== '--major-mode') throw new Error(`Unknown api-export argument: ${option}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
    if (option === '--out') {
      if (destination !== undefined) throw new Error('--out was specified more than once');
      destination = value;
    } else {
      if (majorMode !== undefined) throw new Error('--major-mode was specified more than once');
      majorMode = value;
    }
  }
  if (!destination) throw new Error('api-export requires --out <directory>');
  const outputDirectory = path.resolve(cwd, destination);
  const manifest = exportApiContracts({
    cwd,
    homeDirectory: environment.HOME ?? os.homedir(),
    outputDirectory,
    majorMode,
  });
  output.write(`${JSON.stringify({ directory: outputDirectory, complete: manifest.complete, gaps: manifest.gaps })}\n`);
  return strict && !manifest.complete ? 1 : 0;
}
