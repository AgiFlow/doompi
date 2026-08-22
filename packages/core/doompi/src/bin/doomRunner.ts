#!/usr/bin/env node

/**
 * CLI Entry Point for doom-runner
 *
 * The Runner package is selectable, so this compatibility executable resolves
 * it from the active repository instead of retaining it in DoomPi's dependency
 * closure. The Runner package's own entry only self-invokes when it is argv[1],
 * which it is not once this shim imports it by absolute path.
 */

import { pathToFileURL } from 'node:url';
import { consumerPackageEntry } from '../adapters/modules/moduleResolution.ts';
import { findRepositoryRoot } from '../adapters/repository/repository.ts';

const RUNNER_CLI_EXPORT = '@agimon-ai/doompi-runner/bin/cli';

interface RunnerCliModule {
  readonly main?: unknown;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let repoRoot: string;
  try {
    repoRoot = findRepositoryRoot(process.cwd());
  } catch (error) {
    throw new Error('doom-runner must be invoked inside a configured repository.', { cause: error });
  }
  const entry = consumerPackageEntry(RUNNER_CLI_EXPORT, repoRoot);
  if (!entry) {
    throw new Error(
      'Doom Runner is not installed for this repository. Add @agimon-ai/doompi-runner to .doom/modes.yaml and run doompi sync.',
    );
  }
  const loaded = (await import(pathToFileURL(entry).href)) as RunnerCliModule;
  if (typeof loaded.main !== 'function') {
    throw new Error(`${RUNNER_CLI_EXPORT} does not export a callable main function.`);
  }
  return (loaded.main as (args: readonly string[]) => Promise<number>)(argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[doom-runner] ${message}\n`);
      process.exitCode = 1;
    },
  );
}
