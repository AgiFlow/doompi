#!/usr/bin/env node

/**
 * CLI Entry Point for doom-pi
 *
 * The executable installed as the `doom-pi` binary, and the file the repository
 * launchers (pi.sh, claude.sh, codex.sh) invoke directly from source.
 */

import { HARNESS_VERSION, printHelp } from '../commands/cli/help.ts';

const args = process.argv.slice(2);
const command = args[0];
const ownsArguments = command === 'init' || command === 'sync' || command === 'compat';

// Keep informational startup independent from telemetry, configuration, Pi,
// and the extension compiler. Those graphs are useful for a real command but
// used to account for almost all of `doompi --help` and `doompi --version`.
const informationalExit =
  !ownsArguments && args.some((argument) => argument === '--help' || argument === '-h')
    ? (() => {
        printHelp();
        return 0;
      })()
    : !ownsArguments && args.some((argument) => argument === '--version' || argument === '-v')
      ? (() => {
          process.stdout.write(`${HARNESS_VERSION}\n`);
          return 0;
        })()
      : undefined;

const run =
  informationalExit === undefined
    ? import('../commands/cli/cliApp.ts').then(({ runCli }) => runCli(args))
    : Promise.resolve(informationalExit);

run.then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[doompi] ${message}\n`);
    process.exitCode = 1;
  },
);
