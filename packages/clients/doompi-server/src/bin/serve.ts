#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPackageApis } from '@agimon-ai/doompi-extension-contracts/package-api-loader';
import { DOOM_API_INTERNAL_TOKEN_ENV, DOOM_API_SOCKET_ENV } from '@agimon-ai/doompi-extension-contracts/package-api';
import { DOOM_RELAUNCH_FILE_ENV } from '@agimon-ai/doompi-extension-contracts/relaunch-handoff';
import { superviseAgentRelaunches } from '../adapters/agentSupervisor.ts';
import { createDoomAgentLauncher } from '../adapters/doomAgentLauncher.ts';
import { createAgentServerService } from '../adapters/piSessionRuntime.ts';
import { serveProtocolSocket } from '../adapters/protocolSocket.ts';
import { API_SOCKET_NAME, serveSessionApis } from '../adapters/packageApiServer.ts';
import { removeSessionRecord, writeSessionRecord } from '../adapters/sessionRegistry.ts';
import { removeStaleSocket, serveSessionSocket } from '../adapters/socketServer.ts';
import { startWebCockpit } from '../adapters/webCockpit.ts';
import { REGISTRY_DIR_ENV, resolveRegistryDir } from '../services/registryPaths.ts';
import { parseServeOptions, resolveSessionIdentity } from '../services/serveOptions.ts';
import { SESSION_RECORD_VERSION } from '../types/registry.ts';

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

  const relaunchFile = `${path.resolve(options.socketPath)}.relaunch.json`;
  const apiSocketPath = path.resolve(path.dirname(path.resolve(options.socketPath)), API_SOCKET_NAME);
  const apiInternalToken = crypto.randomBytes(32).toString('base64url');
  const notice = (message: string): void => void process.stderr.write(`[doompi-server] ${message}\n`);
  // The composition runs here rather than inside a launcher child: the only
  // work that child had left was to compose and then wait for Pi to exit.
  const launcher = createDoomAgentLauncher({
    agentArgs: [...agentArgs, ...RPC_MODE_ARGS],
    cwd: process.cwd(),
    environment: {
      ...process.env,
      [DOOM_API_INTERNAL_TOKEN_ENV]: apiInternalToken,
      [DOOM_API_SOCKET_ENV]: apiSocketPath,
      [DOOM_RELAUNCH_FILE_ENV]: relaunchFile,
    },
    // Recording the composition lets a mode switch reload the session in place
    // instead of taking the whole agent down and bringing it back.
    compositionRecordPath: `${path.resolve(options.socketPath)}.composition.json`,
    onNotice: notice,
  });
  const agent = await superviseAgentRelaunches({
    launcher,
    relaunchFile,
    onNotice: notice,
  });
  await removeStaleSocket(options.socketPath);
  const socket = serveSessionSocket({
    socketPath: options.socketPath,
    token,
    agent,
    onNotice: notice,
  });
  process.stderr.write(`[doompi-server] listening on ${options.socketPath}\n`);

  // This session's package APIs, from the module doompi sync generated. They
  // are served on their own socket beside the session's, so a package can
  // answer a question the framed protocol has no shape for.
  const apis = await serveSessionApis({
    socketDir: path.dirname(path.resolve(options.socketPath)),
    sessionId: identity.sessionId,
    cwd: process.cwd(),
    internalToken: apiInternalToken,
    apis: await loadPackageApis('session', { onNotice: notice }),
    onNotice: notice,
  });
  if (apis.socketPath !== undefined) {
    process.stderr.write(`[doompi-server] package APIs on ${apis.socketPath}\n`);
  }

  // Pi's own protocol, served beside the framed socket while clients migrate.
  // A typed, versioned wire is what lets a client use PiClient rather than
  // reimplementing framing and transcript state for itself.
  const protocol = await serveProtocolSocket({
    socketPath: `${path.resolve(options.socketPath)}.pi`,
    service: createAgentServerService({
      agent,
      sessionId: identity.sessionId,
      sessionName: identity.sessionName,
      cwd: process.cwd(),
      createdAt: Date.now(),
    }),
    onNotice: notice,
  });
  process.stderr.write(`[doompi-server] protocol on ${protocol.socketPath}\n`);

  writeSessionRecord(registryDir, {
    version: SESSION_RECORD_VERSION,
    id: identity.sessionId,
    name: identity.sessionName,
    cwd: process.cwd(),
    socketPath: path.resolve(options.socketPath),
    tokenFile: path.resolve(options.tokenFile),
    ...(apis.socketPath === undefined ? {} : { apiSocketPath: apis.socketPath }),
    protocolSocketPath: protocol.socketPath,
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
  await protocol.close();
  await socket.close();
  await launcher.cleanup();
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
