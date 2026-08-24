#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import { serveWeb } from '../adapters/httpServer.ts';
import { REGISTRY_DIR_ENV, resolveRegistryDir } from '../services/registryStore.ts';
import { parseServeOptions } from '../services/serveOptions.ts';
import type { WebServerOptions } from '../types/bridge.ts';

async function main(): Promise<void> {
  const options = parseServeOptions(process.argv.slice(2));
  const shared = {
    port: options.port,
    host: options.host,
    assetsDir: options.assetsDir,
    onNotice: (message: string) => process.stderr.write(`[doompi-web] ${message}\n`),
  };

  let mode: WebServerOptions;
  if (options.socketPath !== undefined && options.tokenFile !== undefined) {
    const token = fs.readFileSync(options.tokenFile, 'utf8').trim();
    if (!token) throw new Error('The attach token file is empty.');
    mode = { ...shared, socketPath: options.socketPath, token };
  } else {
    mode = {
      ...shared,
      registryDir: resolveRegistryDir({
        flagValue: options.registryDir,
        envValue: process.env[REGISTRY_DIR_ENV],
        homeDir: os.homedir(),
      }),
      spawnCommand: options.spawnCommand,
    };
  }

  const server = await serveWeb(mode);

  const stop = (): void => {
    void server.close().then(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error: unknown) => {
  process.stderr.write(`[doompi-web] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
