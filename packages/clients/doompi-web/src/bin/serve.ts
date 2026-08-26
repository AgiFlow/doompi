#!/usr/bin/env node

import os from 'node:os';
import { hubAnswers } from '../adapters/hubProbe.ts';
import { serveWeb } from '../adapters/httpServer.ts';
import { REGISTRY_DIR_ENV, resolveRegistryDir } from '../services/registryStore.ts';
import { parseServeOptions } from '../services/serveOptions.ts';
import type { WebServer } from '../types/bridge.ts';

const ADDRESS_IN_USE = 'EADDRINUSE';

function notice(message: string): void {
  process.stderr.write(`[doompi-web] ${message}\n`);
}

async function main(): Promise<void> {
  const options = parseServeOptions(process.argv.slice(2));
  const url = `http://${options.host}:${String(options.port)}`;

  // One hub serves every session, so a second start is a request to use the
  // running one, not an error worth a stack trace.
  if (await hubAnswers(options.host, options.port)) {
    notice(`cockpit already running at ${url}`);
    return;
  }

  let server: WebServer;
  try {
    server = await serveWeb({
      port: options.port,
      host: options.host,
      assetsDir: options.assetsDir,
      registryDir: resolveRegistryDir({
        flagValue: options.registryDir,
        envValue: process.env[REGISTRY_DIR_ENV],
        homeDir: os.homedir(),
      }),
      spawnCommand: options.spawnCommand,
      onNotice: notice,
    });
  } catch (error) {
    // Two cockpits starting together can both find the port free; the loser
    // settles for the winner rather than reporting a clash nobody caused.
    if ((error as NodeJS.ErrnoException).code !== ADDRESS_IN_USE) throw error;
    if (await hubAnswers(options.host, options.port)) {
      notice(`cockpit already running at ${url}`);
      return;
    }
    throw new Error(`Port ${String(options.port)} is taken by something that is not a DoomPi cockpit; pass --port.`);
  }

  const stop = (): void => {
    void server.close().then(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error: unknown) => {
  notice(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
