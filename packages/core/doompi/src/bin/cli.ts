#!/usr/bin/env node

/**
 * CLI Entry Point for doom-pi
 *
 * The executable installed as the `doom-pi` binary, and the file the repository
 * launchers (pi.sh, claude.sh, codex.sh) invoke directly from source.
 */

import { HARNESS_VERSION, printHelp } from '../controllers/help';
import { informationalRequest, routeCommand } from '../controllers/router';

const args = process.argv.slice(2);
// A named subcommand parses its own arguments, including its own --help, so the
// fast path below must not answer for it.
const ownsArguments = routeCommand(args) !== undefined;

// Keep informational startup independent from telemetry, configuration, Pi,
// and the extension compiler. Those graphs are useful for a real command but
// used to account for almost all of `doompi --help` and `doompi --version`.
const informational = ownsArguments ? undefined : informationalRequest(args);
const informationalExit =
  informational === 'help'
    ? (() => {
        printHelp();
        return 0;
      })()
    : informational === 'version'
      ? (() => {
          process.stdout.write(`${HARNESS_VERSION}\n`);
          return 0;
        })()
      : undefined;

const run =
  informationalExit === undefined
    ? import('../controllers/cliApp').then(({ runCli }) => runCli(args))
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
