#!/usr/bin/env node

import { runDpi } from '../adapters/dpiRunner.ts';

runDpi(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[dpi] ${message}\n`);
    process.exitCode = 1;
  },
);
