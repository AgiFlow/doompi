#!/usr/bin/env node
import { runServer } from '../cli/server/run';

// The library finishes bounded cleanup first. A stale handle must not keep this
// standalone CLI alive forever; an unreferenced deadline still lets output drain.
function finish(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 2_000).unref();
}

runServer(process.argv.slice(2)).then(
  (code) => {
    finish(code);
  },
  (error: unknown) => {
    process.stderr.write(`[doompi-server] ${error instanceof Error ? error.message : String(error)}\n`);
    finish(1);
  },
);
