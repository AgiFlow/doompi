#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPackageApis } from '@agimon-ai/doompi-extension-contracts/package-api-loader';
import { DOOM_API_INTERNAL_TOKEN_ENV, DOOM_API_SOCKET_ENV } from '@agimon-ai/doompi-extension-contracts/package-api';
import { DOOM_RELAUNCH_FILE_ENV } from '@agimon-ai/doompi-extension-contracts/relaunch-handoff';
import { createHarnessTelemetry } from '@agimon-ai/doompi/logSinkTelemetry';
import { superviseAgentRelaunches } from '../adapters/agentSupervisor.ts';
import { createDoomAgentLauncher } from '../adapters/doomAgentLauncher.ts';
import { createAgentServerService } from '../adapters/piSessionRuntime.ts';
import { serveProtocolSocket } from '../adapters/protocolSocket.ts';
import { API_SOCKET_NAME, serveSessionApis } from '../adapters/packageApiServer.ts';
import { removeSessionRecord, writeSessionRecord } from '../adapters/sessionRegistry.ts';
import { removeStaleSocket, serveSessionSocket } from '../adapters/socketServer.ts';
import { createServerTelemetry } from '../adapters/serverTelemetry.ts';
import { startWebCockpit } from '../adapters/webCockpit.ts';
import { REGISTRY_DIR_ENV, resolveRegistryDir } from '../services/registryPaths.ts';
import { parseServeOptions, resolveSessionIdentity } from '../services/serveOptions.ts';
import { SESSION_RECORD_VERSION } from '../types/registry.ts';

const RPC_MODE_ARGS = ['--mode', 'rpc'];
const TELEMETRY_SHUTDOWN_TIMEOUT_MS = 2_000;

async function bounded(operation: Promise<unknown>, label: string, notice: (message: string) => void): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, TELEMETRY_SHUTDOWN_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    notice(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function main(): Promise<number> {
  const options = parseServeOptions(process.argv.slice(2));
  const notice = (message: string): void => void process.stderr.write(`[doompi-server] ${message}\n`);
  const telemetry = createServerTelemetry({ cwd: process.cwd(), env: process.env, warn: notice });
  const harnessTelemetry = createHarnessTelemetry({
    cwd: process.cwd(),
    env: process.env,
    warn: notice,
    deferSpans: true,
  });
  let registryDir: string | undefined;
  let sessionId: string | undefined;
  let launcher: ReturnType<typeof createDoomAgentLauncher> | undefined;
  let agent: Awaited<ReturnType<typeof superviseAgentRelaunches>> | undefined;
  let socket: ReturnType<typeof serveSessionSocket> | undefined;
  let apis: Awaited<ReturnType<typeof serveSessionApis>> | undefined;
  let protocol: Awaited<ReturnType<typeof serveProtocolSocket>> | undefined;
  let cockpit: Awaited<ReturnType<typeof startWebCockpit>> | undefined;
  let exitCleanup: (() => void) | undefined;

  try {
    await telemetry.runInSpan('doompi_server.startup_to_registry', {}, async () => {
      const token = fs.readFileSync(options.tokenFile, 'utf8').trim();
      if (!token) throw new Error('The attach token file is empty.');

      registryDir = resolveRegistryDir({
        flagValue: options.registryDir,
        envValue: process.env[REGISTRY_DIR_ENV],
        homeDir: os.homedir(),
      });
      const resolved = resolveSessionIdentity(options.agentArgs, {
        sessionId: options.sessionId ?? crypto.randomUUID(),
        sessionName: options.sessionName,
      });
      sessionId = resolved.identity.sessionId;
      const relaunchFile = `${path.resolve(options.socketPath)}.relaunch.json`;
      const apiSocketPath = path.resolve(path.dirname(path.resolve(options.socketPath)), API_SOCKET_NAME);
      const apiInternalToken = crypto.randomBytes(32).toString('base64url');
      launcher = createDoomAgentLauncher({
        agentArgs: [...resolved.agentArgs, ...RPC_MODE_ARGS],
        cwd: process.cwd(),
        environment: {
          ...process.env,
          [DOOM_API_INTERNAL_TOKEN_ENV]: apiInternalToken,
          [DOOM_API_SOCKET_ENV]: apiSocketPath,
          [DOOM_RELAUNCH_FILE_ENV]: relaunchFile,
        },
        compositionRecordPath: `${path.resolve(options.socketPath)}.composition.json`,
        telemetry: harnessTelemetry,
        onNotice: notice,
      });
      agent = await superviseAgentRelaunches({
        launcher,
        relaunchFile,
        telemetry,
        onNotice: notice,
      });
      await bounded(harnessTelemetry.flush(), 'initial composition telemetry flush', notice);
      await removeStaleSocket(options.socketPath);
      socket = serveSessionSocket({ socketPath: options.socketPath, token, agent, telemetry, onNotice: notice });
      process.stderr.write(`[doompi-server] listening on ${options.socketPath}\n`);

      apis = await serveSessionApis({
        socketDir: path.dirname(path.resolve(options.socketPath)),
        sessionId: resolved.identity.sessionId,
        cwd: process.cwd(),
        internalToken: apiInternalToken,
        apis: await loadPackageApis('session', { onNotice: notice }),
        telemetry,
        onNotice: notice,
      });
      if (apis.socketPath !== undefined) process.stderr.write(`[doompi-server] package APIs on ${apis.socketPath}\n`);

      protocol = await serveProtocolSocket({
        socketPath: `${path.resolve(options.socketPath)}.pi`,
        service: createAgentServerService({
          agent,
          sessionId: resolved.identity.sessionId,
          sessionName: resolved.identity.sessionName,
          cwd: process.cwd(),
          createdAt: Date.now(),
          telemetry,
        }),
        onNotice: notice,
      });
      process.stderr.write(`[doompi-server] protocol on ${protocol.socketPath}\n`);

      writeSessionRecord(registryDir, {
        version: SESSION_RECORD_VERSION,
        id: resolved.identity.sessionId,
        name: resolved.identity.sessionName,
        cwd: process.cwd(),
        socketPath: path.resolve(options.socketPath),
        tokenFile: path.resolve(options.tokenFile),
        ...(apis.socketPath === undefined ? {} : { apiSocketPath: apis.socketPath }),
        protocolSocketPath: protocol.socketPath,
        pid: process.pid,
        createdAt: new Date().toISOString(),
      });
      exitCleanup = (): void => removeSessionRecord(registryDir!, resolved.identity.sessionId);
      process.on('exit', exitCleanup);
    });

    cockpit =
      options.webPort === undefined
        ? undefined
        : await startWebCockpit({ registryDir: registryDir!, port: options.webPort }, (message) =>
            process.stderr.write(`[doompi-web] ${message}\n`),
          );
    const stop = (): void => agent?.stop();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
      return await agent!.exited;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  } finally {
    await bounded(telemetry.recordEvent('doompi_server.shutdown'), 'shutdown telemetry', notice);
    agent?.stop();
    await Promise.allSettled([
      cockpit?.close(),
      apis?.close(),
      protocol?.close(),
      socket?.close(),
      launcher?.cleanup(),
    ]);
    if (registryDir && sessionId) removeSessionRecord(registryDir, sessionId);
    if (exitCleanup) process.off('exit', exitCleanup);
    await bounded(harnessTelemetry.flush(), 'harness telemetry flush', notice);
    await bounded(harnessTelemetry.shutdown(), 'harness telemetry shutdown', notice);
    await bounded(telemetry.flush(), 'server telemetry flush', notice);
    await bounded(telemetry.shutdown(), 'server telemetry shutdown', notice);
  }
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
