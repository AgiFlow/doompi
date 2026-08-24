#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnAgentProcess } from '../adapters/agentProcess.ts';
import { removeSessionRecord, writeSessionRecord } from '../adapters/sessionRegistry.ts';
import { removeStaleSocket, serveSessionSocket } from '../adapters/socketServer.ts';
import { startWebCockpit } from '../adapters/webCockpit.ts';
import { REGISTRY_DIR_ENV, resolveRegistryDir } from '../services/registryPaths.ts';
import { parseServeOptions, resolveSessionIdentity } from '../services/serveOptions.ts';
import { SESSION_RECORD_VERSION } from '../types/registry.ts';

const DOOMPI_BINARY = 'doompi';
const RPC_MODE_ARGS = ['--mode', 'rpc'];

async function main(): Promise<number> {
  const options = parseServeOptions(process.argv.slice(2));
  const token = fs.readFileSync(options.tokenFile, 'utf8').trim();
  if (!token) throw new Error('The attach token file is empty.');

  const registryDir = resolveRegistryDir({
    flagValue: options.registryDir,
    envValue: process.env[REGISTRY_DIR_ENV],
    homeDir: os.homedir(),
  });
  const { agentArgs, identity } = resolveSessionIdentity(options.agentArgs, {
    sessionId: options.sessionId ?? crypto.randomUUID(),
    sessionName: options.sessionName,
  });

  const agent = spawnAgentProcess({
    command: DOOMPI_BINARY,
    args: [...agentArgs, ...RPC_MODE_ARGS],
    cwd: process.cwd(),
    env: process.env,
  });
  await removeStaleSocket(options.socketPath);
  const socket = serveSessionSocket({
    socketPath: options.socketPath,
    token,
    agent,
    onNotice: (message) => process.stderr.write(`[doompi-server] ${message}\n`),
  });
  process.stderr.write(`[doompi-server] listening on ${options.socketPath}\n`);

  writeSessionRecord(registryDir, {
    version: SESSION_RECORD_VERSION,
    id: identity.sessionId,
    name: identity.sessionName,
    cwd: process.cwd(),
    socketPath: path.resolve(options.socketPath),
    tokenFile: path.resolve(options.tokenFile),
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });
  // A crash skips the normal tail below; this best-effort hook still withdraws
  // the record on any exit path that runs the event loop down.
  process.on('exit', () => removeSessionRecord(registryDir, identity.sessionId));

  const cockpit =
    options.webPort === undefined
      ? undefined
      : await startWebCockpit({ registryDir, port: options.webPort }, (message) =>
          process.stderr.write(`[doompi-web] ${message}\n`),
        );

  const stop = (): void => agent.stop();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const exitCode = await agent.exited;
  await cockpit?.close();
  await socket.close();
  removeSessionRecord(registryDir, identity.sessionId);
  return exitCode;
}

main().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    process.stderr.write(`[doompi-server] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
