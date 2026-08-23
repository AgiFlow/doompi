#!/usr/bin/env node

import fs from 'node:fs';
import { spawnAgentProcess } from '../adapters/agentProcess.ts';
import { serveSessionSocket } from '../adapters/socketServer.ts';
import { parseServeOptions } from '../services/serveOptions.ts';

const DOOMPI_BINARY = 'doompi';
const RPC_MODE_ARGS = ['--mode', 'rpc'];

async function main(): Promise<number> {
  const options = parseServeOptions(process.argv.slice(2));
  const token = fs.readFileSync(options.tokenFile, 'utf8').trim();
  if (!token) throw new Error('The attach token file is empty.');

  const agent = spawnAgentProcess({
    command: DOOMPI_BINARY,
    args: [...options.agentArgs, ...RPC_MODE_ARGS],
    cwd: process.cwd(),
    env: process.env,
  });
  const socket = serveSessionSocket({
    socketPath: options.socketPath,
    token,
    agent,
    onNotice: (message) => process.stderr.write(`[doompi-server] ${message}\n`),
  });
  process.stderr.write(`[doompi-server] listening on ${options.socketPath}\n`);

  const stop = (): void => agent.stop();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const exitCode = await agent.exited;
  await socket.close();
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
