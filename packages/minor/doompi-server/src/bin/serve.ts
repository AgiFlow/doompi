#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPackageApis } from '@agimon-ai/doompi-extension-contracts/package-api-loader';
import { DOOM_RELAUNCH_FILE_ENV } from '@agimon-ai/doompi-extension-contracts/relaunch-handoff';
import { superviseAgentRelaunches } from '../adapters/agentSupervisor.ts';
import { serveSessionApis } from '../adapters/packageApiServer.ts';
import { removeSessionRecord, writeSessionRecord } from '../adapters/sessionRegistry.ts';
import { removeStaleSocket, serveSessionSocket } from '../adapters/socketServer.ts';
import { startWebCockpit } from '../adapters/webCockpit.ts';
import { REGISTRY_DIR_ENV, resolveRegistryDir } from '../services/registryPaths.ts';
import { parseServeOptions, resolveSessionIdentity } from '../services/serveOptions.ts';
import { SESSION_RECORD_VERSION } from '../types/registry.ts';

const DOOMPI_BINARY = 'doompi';
const RPC_MODE_ARGS = ['--mode', 'rpc'];
const AGENT_COMMAND_ENV = 'DOOMPI_AGENT_COMMAND';
const REPO_LOCAL_CLI = ['node_modules', '@agimon-ai', 'doompi', 'dist', 'bin', 'cli.mjs'];

/**
 * The agent launcher for this session's working directory.
 *
 * A repository that pins its own DoomPi runs that exact version, mirroring how
 * pi.sh resolves the repo-local CLI. DOOMPI_AGENT_COMMAND overrides the lookup
 * (a .mjs/.js path runs under this node), and the PATH binary is the fallback.
 */
function resolveAgentCommand(cwd: string, env: NodeJS.ProcessEnv): { command: string; prefixArgs: string[] } {
  const override = env[AGENT_COMMAND_ENV];
  if (override) {
    return override.endsWith('.mjs') || override.endsWith('.js')
      ? { command: process.execPath, prefixArgs: [override] }
      : { command: override, prefixArgs: [] };
  }
  for (let directory = cwd; ; directory = path.dirname(directory)) {
    const cli = path.join(directory, ...REPO_LOCAL_CLI);
    if (fs.existsSync(cli)) return { command: process.execPath, prefixArgs: [cli] };
    if (directory === path.dirname(directory)) break;
  }
  return { command: DOOMPI_BINARY, prefixArgs: [] };
}

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

  const relaunchFile = `${path.resolve(options.socketPath)}.relaunch.json`;
  const launcher = resolveAgentCommand(process.cwd(), process.env);
  const agent = superviseAgentRelaunches({
    command: launcher.command,
    args: [...launcher.prefixArgs, ...agentArgs, ...RPC_MODE_ARGS],
    cwd: process.cwd(),
    env: { ...process.env, [DOOM_RELAUNCH_FILE_ENV]: relaunchFile },
    relaunchFile,
    onNotice: (message) => process.stderr.write(`[doompi-server] ${message}\n`),
  });
  await removeStaleSocket(options.socketPath);
  const socket = serveSessionSocket({
    socketPath: options.socketPath,
    token,
    agent,
    onNotice: (message) => process.stderr.write(`[doompi-server] ${message}\n`),
  });
  process.stderr.write(`[doompi-server] listening on ${options.socketPath}\n`);

  // This session's package APIs, from the module doompi sync generated. They
  // are served on their own socket beside the session's, so a package can
  // answer a question the framed protocol has no shape for.
  const apiNotice = (message: string): void => void process.stderr.write(`[doompi-server] ${message}\n`);
  const apis = await serveSessionApis({
    socketDir: path.dirname(path.resolve(options.socketPath)),
    sessionId: identity.sessionId,
    cwd: process.cwd(),
    apis: await loadPackageApis('session', { onNotice: apiNotice }),
    onNotice: apiNotice,
  });
  if (apis.socketPath !== undefined) {
    process.stderr.write(`[doompi-server] package APIs on ${apis.socketPath}\n`);
  }

  writeSessionRecord(registryDir, {
    version: SESSION_RECORD_VERSION,
    id: identity.sessionId,
    name: identity.sessionName,
    cwd: process.cwd(),
    socketPath: path.resolve(options.socketPath),
    tokenFile: path.resolve(options.tokenFile),
    ...(apis.socketPath === undefined ? {} : { apiSocketPath: apis.socketPath }),
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
  await apis.close();
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
