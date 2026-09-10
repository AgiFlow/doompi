#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPackageApis, PACKAGE_API_DIR_ENV } from '@agimon-ai/doompi-extension-contracts/package-api-loader';
import {
  loadServerBundle,
  loadServerFacets,
  resolveServerBundleSource,
} from '@agimon-ai/doompi-extension-contracts/server-facet-loader';
import { DOOM_API_INTERNAL_TOKEN_ENV, DOOM_API_SOCKET_ENV } from '@agimon-ai/doompi-extension-contracts/package-api';
import { DOOM_RELAUNCH_FILE_ENV } from '@agimon-ai/doompi-extension-contracts/relaunch-handoff';
import { resolveHarnessOptions } from '../commands/cli/harnessOptions';
import { buildHarnessContext } from '../adapters/harnessContext.ts';
import { layerHookGroups, loadMajorModesConfig, resolveLayers } from '@agimon-ai/doompi-config/majorModes';
import { createHarnessTelemetry } from '../adapters/telemetry/logSinkTelemetry';
import { findRepositoryRoot } from '../adapters/repository/repository';
import { readSyncRegistration, type SyncRegistration } from '../adapters/syncRegistration';
import { superviseAgentRelaunches } from '../adapters/server/agentSupervisor.ts';
import { createHeadlessSessionHost, isDirectHeadlessOptedIn } from '../adapters/server/headlessSessionHost.ts';
import { createDoomAgentLauncher } from '../adapters/server/doomAgentLauncher.ts';
import { createAgentServerService } from '../adapters/server/piSessionRuntime.ts';
import { serveProtocolSocket } from '../adapters/server/protocolSocket.ts';
import { API_SOCKET_NAME, serveSessionApis } from '../adapters/server/packageApiServer.ts';
import { removeSessionRecord, writeSessionRecord } from '../adapters/server/sessionRegistry.ts';
import { removeStaleSocket, serveSessionSocket } from '../adapters/server/socketServer.ts';
import { createServerTelemetry } from '../adapters/server/serverTelemetry.ts';
import { startWebCockpit } from '../adapters/server/webCockpit.ts';
import { REGISTRY_DIR_ENV, resolveRegistryDir } from '../services/server/registryPaths.ts';
import { parseServeOptions, resolveSessionIdentity } from '../services/server/serveOptions.ts';
import { SESSION_RECORD_VERSION } from '../types/server/registry.ts';
import type { AgentProcess } from '../types/server/session.ts';

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

function registeredSync(from: string): SyncRegistration | undefined {
  let repositoryRoot: string;
  try {
    repositoryRoot = findRepositoryRoot(from);
  } catch {
    return undefined;
  }
  return readSyncRegistration(repositoryRoot);
}

function currentServerBundleSelection(agentArgs: readonly string[]): {
  root: string;
  majorMode: string;
  activeLayers: string[];
} {
  const options = resolveHarnessOptions({ args: agentArgs, cwd: process.cwd(), environment: process.env });
  const config = loadMajorModesConfig(options.repoRoot, options.homeDirectory);
  const layers = resolveLayers(config, options.majorMode);
  return {
    root: options.repoRoot,
    majorMode: options.majorMode,
    activeLayers: options.hooks ? layers : layers.filter((layer) => layerHookGroups(config, [layer]).length === 0),
  };
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
  let agent: AgentProcess | undefined;
  let directHost: Awaited<ReturnType<typeof createHeadlessSessionHost>> | undefined;
  let harnessContext: Awaited<ReturnType<typeof buildHarnessContext>> | undefined;
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
      const directMode = isDirectHeadlessOptedIn();

      const installationDir = path.dirname(fileURLToPath(import.meta.url));
      const selectedRegistration = registeredSync(process.cwd()) ?? registeredSync(installationDir);
      const source = resolveServerBundleSource({
        registration: selectedRegistration,
        directoryOverride: process.env[PACKAGE_API_DIR_ENV],
      });
      const selection = source.kind === 'descriptor' ? currentServerBundleSelection(resolved.agentArgs) : undefined;
      const loadedBundle =
        source.kind === 'descriptor' && selection !== undefined
          ? await loadServerBundle('session', {
              ...source,
              ...selection,
              ...(directMode ? { retainCandidates: true } : {}),
              onNotice: notice,
            })
          : undefined;
      if (directMode) {
        if (source.kind !== 'descriptor' || selection === undefined || loadedBundle === undefined)
          throw new Error('Direct headless mode requires an admitted descriptor server bundle.');
        harnessContext = await buildHarnessContext(
          resolveHarnessOptions({ args: resolved.agentArgs, cwd: process.cwd(), environment: process.env }),
          harnessTelemetry,
        );
        // This process is the session host, so apply the same environment the RPC child received.
        for (const key of Object.keys(process.env)) {
          if (!(key in harnessContext.environment)) delete process.env[key];
        }
        Object.assign(process.env, harnessContext.environment, {
          [DOOM_API_INTERNAL_TOKEN_ENV]: apiInternalToken,
          [DOOM_API_SOCKET_ENV]: apiSocketPath,
        });
        directHost = await createHeadlessSessionHost({
          cwd: harnessContext.options.cwd,
          repoRoot: harnessContext.options.repoRoot,
          sessionId: resolved.identity.sessionId,
          sessionName: resolved.identity.sessionName,
          agentArgs: harnessContext.options.piArgs,
          selection: {
            ...selection,
            domains: harnessContext.options.domains,
            profile: harnessContext.profile,
            minorModes: [],
          },
          candidates: loadedBundle.descriptor.entries,
          onNotice: notice,
        });
        agent = directHost.agent;
      } else {
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
      }
      await bounded(harnessTelemetry.flush(), 'initial composition telemetry flush', notice);
      await removeStaleSocket(options.socketPath);
      socket = serveSessionSocket({ socketPath: options.socketPath, token, agent, telemetry, onNotice: notice });
      process.stderr.write(`[doompi-server] listening on ${options.socketPath}\n`);
      apis = await serveSessionApis({
        socketDir: path.dirname(path.resolve(options.socketPath)),
        sessionId: resolved.identity.sessionId,
        cwd: process.cwd(),
        internalToken: apiInternalToken,
        hubToken: token,
        apis:
          source.kind === 'legacy'
            ? await loadPackageApis('session', { apiDirectory: source.directory, env: {}, onNotice: notice })
            : [],
        facets:
          loadedBundle?.facets ??
          (source.kind === 'legacy'
            ? await loadServerFacets('session', { apiDirectory: source.directory, env: {}, onNotice: notice })
            : []),
        prepareFacets: directHost?.prepareFacets,
        activateFacets: directHost?.activateFacets,
        canDispatch: directHost?.canDispatch,
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
        protocolServerId: protocol.serverId,
        ...(source.kind === 'descriptor' && selection !== undefined
          ? {
              serverComposition: {
                ...selection,
                apiDirectory: source.directory,
                generation: source.generation,
                fingerprint: source.fingerprint,
              },
            }
          : {}),
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
    if (directHost) {
      try {
        await directHost.dispose();
      } catch (error) {
        notice(error instanceof Error ? error.message : String(error));
      }
    } else agent?.stop();
    await Promise.allSettled([
      cockpit?.close(),
      apis?.close(),
      protocol?.close(),
      socket?.close(),
      launcher?.cleanup(),
      harnessContext?.cleanup(),
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
