#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import { loadServerBundle, resolveServerBundleSource } from '@agimon-ai/doompi-extension-contracts/server-facet';
import type {
  DoomHubSessionApiRequest,
  DoomHubSessionCreateRequest,
  DoomHubSessionScope,
} from '@agimon-ai/doompi-extension-contracts/hub-channel';
import { resolveHarnessOptions } from '../commands/cli/harnessOptions';
import { buildHarnessContext } from '../adapters/harnessContext.ts';
import { filterHookDisabledLayers, loadMajorModesConfig, resolveLayers } from '@agimon-ai/doompi-config/majorModes';
import { createHarnessTelemetry } from '../adapters/telemetry/logSinkTelemetry';
import { findRepositoryRoot } from '../adapters/repository/repository';
import { readSyncRegistration, type SyncRegistration } from '../adapters/syncRegistration';
import { createHeadlessHub, type HeadlessHub } from '../adapters/server/headlessHub.ts';
import { createHeadlessSessionManager } from '../adapters/server/headlessSessionManager.ts';
import type { HeadlessSessionHost, HeadlessSessionHostOptions } from '../types/server/headlessSessionHost.ts';
import type { HeadlessSessionManager } from '../types/server/headlessSessionManager.ts';
import { serveSessionApis, type PackageApiServer } from '../adapters/server/packageApiServer.ts';
import { createServerTelemetry } from '../adapters/server/serverTelemetry.ts';
import { serveHeadlessServer } from '../adapters/server/headlessServer.ts';
import { parseServeOptions, resolveSessionIdentity } from '../services/server/serveOptions.ts';
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

function currentServerBundleSelection(
  agentArgs: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): {
  root: string;
  majorMode: string;
  activeLayers: string[];
} {
  const options = resolveHarnessOptions({ args: agentArgs, cwd, environment });
  const config = loadMajorModesConfig(options.repoRoot, options.homeDirectory);
  const layers = resolveLayers(config, options.majorMode);
  return {
    root: options.repoRoot,
    majorMode: options.majorMode,
    activeLayers: filterHookDisabledLayers(config, layers, options.hooks),
  };
}

async function main(): Promise<number> {
  const options = parseServeOptions(process.argv.slice(2));
  const baseCwd = process.cwd();
  const baseEnvironment = Object.freeze({ ...process.env });
  const notice = (message: string): void => void process.stderr.write(`[doompi-server] ${message}\n`);
  const telemetry = createServerTelemetry({ cwd: baseCwd, env: baseEnvironment, warn: notice });
  const harnessTelemetry = createHarnessTelemetry({
    cwd: baseCwd,
    env: baseEnvironment,
    warn: notice,
    deferSpans: true,
  });
  const baseSessionManager = createHeadlessSessionManager();
  type SessionSetup = { cleanup: () => Promise<void> };
  type SessionArtifacts = SessionSetup & { apis: PackageApiServer };
  const pendingSessions = new Map<string, SessionSetup>();
  const sessionArtifacts = new Map<string, SessionArtifacts>();
  let mountSessionApis:
    | ((options: HeadlessSessionHostOptions, host: HeadlessSessionHost) => Promise<PackageApiServer>)
    | undefined;

  const closeManagedSession = async (sessionId: string): Promise<void> => {
    const artifacts = sessionArtifacts.get(sessionId);
    sessionArtifacts.delete(sessionId);
    const failures: unknown[] = [];
    try {
      await artifacts?.apis.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await artifacts?.cleanup();
    } catch (error) {
      failures.push(error);
    }
    try {
      await baseSessionManager.closeSession(sessionId);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, `Session '${sessionId}' shutdown failed`);
  };

  const sessionManager: HeadlessSessionManager = {
    async create(sessionOptions) {
      const setup = pendingSessions.get(sessionOptions.sessionId);
      let host: HeadlessSessionHost;
      try {
        host = await baseSessionManager.create(sessionOptions);
      } catch (error) {
        if (setup !== undefined && pendingSessions.delete(sessionOptions.sessionId))
          await setup.cleanup().catch((cleanupError: unknown) => notice(String(cleanupError)));
        throw error;
      }
      if (setup === undefined || mountSessionApis === undefined) return host;
      try {
        const apis = await mountSessionApis(sessionOptions, host);
        pendingSessions.delete(sessionOptions.sessionId);
        sessionArtifacts.set(sessionOptions.sessionId, { ...setup, apis });
        return host;
      } catch (error) {
        pendingSessions.delete(sessionOptions.sessionId);
        await baseSessionManager
          .closeSession(sessionOptions.sessionId)
          .catch((closeError: unknown) => notice(String(closeError)));
        await setup.cleanup().catch((cleanupError: unknown) => notice(String(cleanupError)));
        throw error;
      }
    },
    get: (sessionId) => baseSessionManager.get(sessionId),
    sessions: () => baseSessionManager.sessions(),
    closeSession: closeManagedSession,
    async close() {
      const ids = baseSessionManager.sessions().map((session) => session.runtime.sessionId);
      const outcomes = await Promise.allSettled(ids.map((id) => closeManagedSession(id)));
      const failures = outcomes
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        .map((outcome) => outcome.reason);
      if (failures.length > 0) throw new AggregateError(failures, 'Headless session shutdown failed');
    },
  };

  let requestSessionApi: (
    scope: DoomHubSessionScope,
    request: DoomHubSessionApiRequest,
  ) => Promise<Response> = async () => Response.json({ error: 'Session API unavailable.' }, { status: 404 });
  let createSession: (request: DoomHubSessionCreateRequest) => Promise<DoomHubSessionScope> = async () => {
    throw new Error('The cockpit session service is not ready.');
  };
  let hub!: HeadlessHub;
  hub = createHeadlessHub({
    manager: sessionManager,
    createSession: (request) => createSession(request),
    onNotice: notice,
    requestSessionApi: (scope, request) => requestSessionApi(scope, request),
  });
  let harnessContext: Awaited<ReturnType<typeof buildHarnessContext>> | undefined;
  let cockpit: Awaited<ReturnType<typeof serveHeadlessServer>> | undefined;
  let attachToken: string | undefined;

  try {
    await telemetry.runInSpan('doompi_server.startup', {}, async () => {
      const token = fs.readFileSync(options.tokenFile, 'utf8').trim();
      if (!token) throw new Error('The attach token file is empty.');
      attachToken = token;

      const resolved = resolveSessionIdentity(options.agentArgs, {
        sessionId: options.sessionId ?? crypto.randomUUID(),
        sessionName: options.sessionName,
      });

      const selectedRegistration = registeredSync(baseCwd);
      const source = resolveServerBundleSource({ registration: selectedRegistration });
      const selection =
        source.kind === 'descriptor'
          ? currentServerBundleSelection(resolved.agentArgs, baseCwd, baseEnvironment)
          : undefined;
      const loadedBundle =
        source.kind === 'descriptor' && selection !== undefined
          ? await loadServerBundle('session', {
              ...source,
              ...selection,
              retainCandidates: true,
              onNotice: notice,
            })
          : undefined;
      const loadedHubBundle =
        source.kind === 'descriptor' && selection !== undefined
          ? await loadServerBundle('hub', { ...source, ...selection, onNotice: notice })
          : undefined;
      if (
        source.kind !== 'descriptor' ||
        selection === undefined ||
        loadedBundle === undefined ||
        loadedHubBundle === undefined
      )
        throw new Error('The headless server requires an admitted descriptor server bundle.');
      await hub.mountFacets(loadedHubBundle.facets);

      const sessionHostOptions = (
        context: Awaited<ReturnType<typeof buildHarnessContext>>,
        identity: {
          sessionId: string;
          sessionName: string;
          parentSessionId?: string;
          sessionProvenance?: string;
        },
      ): HeadlessSessionHostOptions => {
        const policyOptions = context.options;
        const sessionSelection = {
          ...selection,
          activeLayers: context.selectedLayers,
          domains: policyOptions.domains,
          profile: context.profile,
          minorModes: [],
        };
        return {
          cwd: policyOptions.cwd,
          repoRoot: policyOptions.repoRoot,
          sessionId: identity.sessionId,
          sessionName: identity.sessionName,
          ...(identity.parentSessionId === undefined ? {} : { parentSessionId: identity.parentSessionId }),
          ...(identity.sessionProvenance === undefined ? {} : { sessionProvenance: identity.sessionProvenance }),
          agentArgs: policyOptions.piArgs,
          environment: Object.freeze({ ...context.environment }),
          selection: sessionSelection,
          candidates: loadedBundle.descriptor.entries,
          resolveSelection: (requested) => {
            const config = loadMajorModesConfig(policyOptions.repoRoot, policyOptions.homeDirectory);
            return {
              ...requested,
              activeLayers: filterHookDisabledLayers(
                config,
                resolveLayers(config, requested.majorMode),
                policyOptions.hooks,
              ),
            };
          },
          onNotice: notice,
        };
      };

      mountSessionApis = (sessionOptions, host) =>
        serveSessionApis({
          sessionId: sessionOptions.sessionId,
          cwd: sessionOptions.cwd,
          environment: sessionOptions.environment,
          directEvents: hub.directEvents,
          hubToken: token,
          sessionService: hub.sessionService,
          apis: [],
          facets: loadedBundle.facets,
          prepareFacets: host.prepareFacets,
          activateFacets: host.activateFacets,
          canDispatch: host.canDispatch,
          telemetry,
          onNotice: notice,
        });

      harnessContext = await buildHarnessContext(
        resolveHarnessOptions({ args: resolved.agentArgs, cwd: baseCwd, environment: baseEnvironment }),
        harnessTelemetry,
      );

      requestSessionApi = async (scope, request) => {
        const session = hub.session(scope.sessionId);
        const artifacts = sessionArtifacts.get(scope.sessionId);
        if (session === undefined || session.cwd !== scope.cwd || artifacts === undefined)
          return Response.json({ error: 'Session not found.' }, { status: 404 });
        if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(request.basePath))
          return Response.json({ error: 'Invalid session API base path.' }, { status: 400 });
        if (!request.path.startsWith('/') || request.path.startsWith('//') || request.path.includes('#'))
          return Response.json({ error: 'Invalid session API path.' }, { status: 400 });
        const body = request.body === null || request.body === undefined ? undefined : request.body;
        return artifacts.apis.request(
          new Request(`http://doompi.local/api/plugin/${request.basePath}${request.path}`, {
            method: request.method,
            ...(body === undefined ? {} : { body }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          }),
        );
      };

      const activeHarnessContext = harnessContext;
      pendingSessions.set(resolved.identity.sessionId, { cleanup: () => activeHarnessContext.cleanup() });
      await hub.create(sessionHostOptions(harnessContext, resolved.identity));
      await bounded(harnessTelemetry.flush(), 'initial composition telemetry flush', notice);

      createSession = async (request) => {
        const identity = {
          sessionId: crypto.randomUUID(),
          sessionName: request.name,
          parentSessionId: request.parentSessionId,
          sessionProvenance: request.sessionProvenance,
        };
        const childIdentity = resolveSessionIdentity(options.agentArgs, identity);
        const childContext = await buildHarnessContext(
          resolveHarnessOptions({ args: childIdentity.agentArgs, cwd: request.cwd, environment: baseEnvironment }),
          harnessTelemetry,
        );
        pendingSessions.set(identity.sessionId, { cleanup: () => childContext.cleanup() });
        try {
          await hub.create(sessionHostOptions(childContext, identity));
          return { sessionId: identity.sessionId, cwd: childContext.options.cwd };
        } catch (error) {
          if (pendingSessions.delete(identity.sessionId))
            await childContext.cleanup().catch((cleanupError: unknown) => notice(String(cleanupError)));
          throw error;
        }
      };
    });

    cockpit = await serveHeadlessServer({
      port: options.webPort,
      headlessHub: hub,
      token: attachToken,
      onNotice: (message) => process.stderr.write(`[doompi-server] ${message}\n`),
    });
    process.stderr.write(`[doompi-server] protocol on ${cockpit.url}/api/pi\n`);
    let resolveShutdown!: (exitCode: number) => void;
    const shutdown = new Promise<number>((resolve) => {
      resolveShutdown = resolve;
    });
    const stop = (): void => resolveShutdown(0);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
      return await shutdown;
    } finally {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  } finally {
    await bounded(telemetry.recordEvent('doompi_server.shutdown'), 'shutdown telemetry', notice);
    await Promise.allSettled([cockpit?.close()]);
    try {
      await hub.close();
    } catch (error) {
      notice(error instanceof Error ? error.message : String(error));
    }
    try {
      await sessionManager.close();
    } catch (error) {
      notice(error instanceof Error ? error.message : String(error));
    }
    const pendingCleanups = [...pendingSessions.values()].map((setup) => setup.cleanup());
    pendingSessions.clear();
    await Promise.allSettled(pendingCleanups);
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
