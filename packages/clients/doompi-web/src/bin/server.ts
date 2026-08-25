#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import process from 'node:process';

import { bundledServerLaunch } from '../adapters/bundledServer.js';

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 1;
}

function main(): number {
  const launch = bundledServerLaunch(process.argv.slice(2), process.cwd(), process.env);
  const result = spawnSync(launch.command, launch.args, {
    env: launch.environment,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  return result.status ?? signalExitCode(result.signal);
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
