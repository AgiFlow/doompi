import { readMinorModeCatalog } from '@agimon-ai/doompi-minor-mode';
import { publishHeadlessSelectionStatus } from './selectionStatus';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HARNESS_STATE_KEYS, HARNESS_STATE_POINTER } from '../../composition/harnessState';
import { createWebCompositions } from '@agimon-ai/doompi-core/web-compositions';
import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config/config';
import { resolveSyncLocation } from '@agimon-ai/doompi-core/sync-location';
import { loadServerBundle, resolveServerBundleSource } from '@agimon-ai/doompi-core/server-facet';
import type {
  DoomHubSessionApiRequest,
  DoomHubSessionCreateRequest,
  DoomHubSessionScope,
} from '@agimon-ai/doompi-core/hub-channel';
import { buildHarnessContext } from '../cli/harnessContext';
import { filterHookDisabledLayers, loadMajorModesConfig, resolveLayers } from '@agimon-ai/doompi-config/majorModes';
import { createHarnessTelemetry } from '@agimon-ai/doompi-core/runtime-log-sink-telemetry';
import { findRepositoryRoot } from '../../composition/repository';
import { readSyncRegistration } from '@agimon-ai/doompi-core/sync-registration';
import { createHeadlessHub, type HeadlessHub } from '@agimon-ai/doompi-core/headless-hub';
import { createHeadlessSessionManager } from '@agimon-ai/doompi-core/headless-session-manager';
import type { HeadlessSessionHost, HeadlessSessionHostOptions } from '@agimon-ai/doompi-core/headless-session-host';
import type { HeadlessSessionManager } from '@agimon-ai/doompi-core/runtime-headless-session-manager';
import { serveSessionApis, type PackageApiServer } from '@agimon-ai/doompi-core/package-api-server';
import { createServerTelemetry } from '@agimon-ai/doompi-core/server-telemetry';
import { serveHeadlessServer } from '@agimon-ai/doompi-core/headless-server';
import { createRemoteRuntime, type RemoteRuntime } from '@agimon-ai/doompi-core/remote-runtime';
import WebSocket from 'ws';
import { resolveSessionIdentity } from './sessionArguments';
import type { ServeOptions, ServerRuntimeEnvironment } from './types';
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

export async function runServerRuntime(options: ServeOptions, runtime: ServerRuntimeEnvironment): Promise<number> {
  const { cwd: baseCwd, environment: baseEnvironment, notice, resolveHarnessOptions, signal } = runtime;
  const telemetry = createServerTelemetry({ cwd: baseCwd, env: baseEnvironment, warn: notice });
  let nextEventLoopTick = performance.now() + 1_000;
  const eventLoopMonitor = setInterval(() => {
    const now = performance.now();
    const delay = Math.max(0, now - nextEventLoopTick);
    nextEventLoopTick = now + 1_000;
    if (delay >= 100)
      void telemetry
        .recordEvent('doompi_server.event_loop_delay', { duration_ms: Math.round(delay) })
        .catch((error: unknown) => notice(`event loop telemetry failed: ${String(error)}`));
  }, 1_000);
  eventLoopMonitor.unref();
  const harnessTelemetry = createHarnessTelemetry({
    cwd: baseCwd,
    env: baseEnvironment,
    warn: notice,
    deferSpans: true,
  });
  const baseSessionManager = createHeadlessSessionManager({
    publishSelectionStatus: publishHeadlessSelectionStatus,
    contextGroups: (context) =>
      (readMinorModeCatalog(context)?.list() ?? [])
        .filter(({ state }) => state.activation === 'active')
        .map(({ descriptor }) => ({ id: descriptor.id, label: descriptor.label, kind: 'minor' })),
  });
  type SessionSetup = { cleanup: () => Promise<void>; bundle: Awaited<ReturnType<typeof loadServerBundle>> };
  type SessionArtifacts = SessionSetup & { apis: PackageApiServer };
  const pendingSessions = new Map<string, SessionSetup>();
  const sessionArtifacts = new Map<string, SessionArtifacts>();
  let mountSessionApis:
    | ((options: HeadlessSessionHostOptions, host: HeadlessSessionHost) => Promise<PackageApiServer>)
    | undefined;

  const closeManagedSession = async (sessionId: string): Promise<void> => {
    const artifacts = sessionArtifacts.get(sessionId);
    sessionArtifacts.delete(sessionId);
    webCompositions?.remove({ scope: 'session', sessionId });
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
  let admitWorkspace: (root: string) => Promise<{ id: string; root: string }> = async () => {
    throw new Error('Workspace admission is not ready.');
  };
  let hub!: HeadlessHub;
  hub = createHeadlessHub({
    manager: sessionManager,
    admitWorkspace: (root) => admitWorkspace(root),
    onWorkspaceRemoved: (workspaceId) => webCompositions?.remove({ scope: 'workspace', workspaceId }),
    createSession: (request) => createSession(request),
    onNotice: notice,
    requestSessionApi: (scope, request) => requestSessionApi(scope, request),
  });
  let harnessContext: Awaited<ReturnType<typeof buildHarnessContext>> | undefined;
  let cockpit: Awaited<ReturnType<typeof serveHeadlessServer>> | undefined;
  let remoteRuntime: RemoteRuntime | undefined;
  let attachToken: string | undefined;
  let webCompositions: ReturnType<typeof createWebCompositions> | undefined;

  try {
    await telemetry.runInSpan('doompi_server.startup', {}, async () => {
      const token = fs.readFileSync(options.tokenFile, 'utf8').trim();
      if (!token) throw new Error('The attach token file is empty.');
      attachToken = token;

      const resolved = resolveSessionIdentity(options.agentArgs, {
        sessionId: options.sessionId ?? crypto.randomUUID(),
        sessionName: options.sessionName,
      });

      const homeDirectory = baseEnvironment.HOME ?? os.homedir();
      const globalRoot = globalDoomConfigDirectory(homeDirectory);
      webCompositions = createWebCompositions(path.join(globalRoot, 'server'), notice);
      const loadComposition = async (
        root: string,
        scope: 'global' | 'workspace' | 'session',
        selection?: { root: string; majorMode: string; activeLayers: string[] },
      ) => {
        const registration = readSyncRegistration(root, homeDirectory);
        const source = resolveServerBundleSource({ registration });
        if (source.kind !== 'descriptor')
          throw new Error(`Run the scoped DoomPi sync for '${root}' before opening it.`);
        const selected =
          selection ??
          (() => {
            const config = loadMajorModesConfig(root, homeDirectory);
            const majorMode = config.defaultMajorMode;
            return { root, majorMode, activeLayers: resolveLayers(config, majorMode) };
          })();
        return loadServerBundle(scope, {
          ...source,
          ...selected,
          retainCandidates: scope === 'session',
          onNotice: notice,
        });
      };
      const sharedApiContext = {
        homeDirectory,
        environment: baseEnvironment,
        hubToken: token,
        sessionService: hub.sessionService,
        directEvents: hub.directEvents,
        repositories: () =>
          hub.workspaces().map((workspace) => ({
            id: workspace.id,
            path: workspace.root,
            name: workspace.root.split('/').at(-1) ?? workspace.id,
            active: hub.snapshot().some((session) => session.workspaceId === workspace.id),
          })),
        resolveRepository: (id: string) => hub.workspaces().find((workspace) => workspace.id === id)?.root,
        onNotice: notice,
      };
      const globalBundle = await loadComposition(globalRoot, 'global');
      webCompositions.publishShell(readSyncRegistration(globalRoot, homeDirectory)!);
      remoteRuntime = createRemoteRuntime({
        homeDirectory,
        registrationToken: token,
        bundleTrust: () => webCompositions?.shellTrust(),
        onNotice: notice,
        forward: async (request) => {
          if (!cockpit || !attachToken)
            return Response.json({ error: 'The headless server is not ready.' }, { status: 503 });
          const from = new URL(request.url);
          const headers = new Headers(request.headers);
          headers.set('x-doompi-token', attachToken);
          return fetch(new URL(`${from.pathname}${from.search}`, cockpit.url), new Request(request, { headers }));
        },
        connectProtocol: () => {
          if (!cockpit || !attachToken) throw new Error('The headless protocol listener is not ready.');
          const url = new URL('/api/pi', cockpit.url);
          url.protocol = 'ws:';
          return new WebSocket(url, { headers: { 'x-doompi-token': attachToken } });
        },
      });
      await hub.mountFacets(globalBundle.facets, {
        ...sharedApiContext,
        scope: 'global',
        remoteControl: { fetch: (request: Request) => remoteRuntime!.fetchLocal(request) },
      });
      webCompositions.publish(
        { scope: 'global' },
        readSyncRegistration(globalRoot, homeDirectory)!,
        hub.channelTypes(),
      );
      const admissions = new Map<string, Promise<{ id: string; root: string }>>();
      admitWorkspace = async (from) => {
        const root = fs.realpathSync(findRepositoryRoot(from));
        const id = resolveSyncLocation(root, homeDirectory).identity.worktreeId;
        const existing = hub.workspaces().find((workspace) => workspace.id === id);
        if (existing) return existing;
        const pending = admissions.get(id);
        if (pending) return pending;
        const admission = (async () => {
          const bundle = await loadComposition(root, 'workspace');
          await hub.mountFacets(bundle.facets, {
            ...sharedApiContext,
            scope: 'workspace',
            workspaceId: id,
            workspaceRoot: root,
            cwd: root,
            resolveRepository: (requestedId) => (requestedId === id ? root : undefined),
          });
          webCompositions?.publish(
            { scope: 'workspace', workspaceId: id },
            readSyncRegistration(root, homeDirectory)!,
            hub.channelTypes(),
          );
          return { id, root };
        })();
        admissions.set(id, admission);
        try {
          return await admission;
        } finally {
          admissions.delete(id);
        }
      };

      const sessionHostOptions = (
        context: Awaited<ReturnType<typeof buildHarnessContext>>,
        bundle: Awaited<ReturnType<typeof loadServerBundle>>,
        identity: {
          sessionId: string;
          sessionName: string;
          parentSessionId?: string;
          sessionProvenance?: string;
        },
      ): HeadlessSessionHostOptions => {
        const policyOptions = context.options;
        const sessionSelection = {
          root: policyOptions.repoRoot,
          majorMode: policyOptions.majorMode,
          activeLayers: context.selectedLayers,
          domains: policyOptions.domains,
          profile: context.profile,
          state: { 'minor-mode': [] },
        };
        return {
          cwd: policyOptions.cwd,
          repoRoot: policyOptions.repoRoot,
          sessionId: identity.sessionId,
          workspaceId: resolveSyncLocation(policyOptions.repoRoot, homeDirectory).identity.worktreeId,
          sessionName: identity.sessionName,
          webComposition: webCompositions?.publish(
            { scope: 'session', sessionId: identity.sessionId },
            readSyncRegistration(policyOptions.repoRoot, homeDirectory)!,
            hub.channelTypes(),
          ),
          ...(identity.parentSessionId === undefined ? {} : { parentSessionId: identity.parentSessionId }),
          ...(identity.sessionProvenance === undefined ? {} : { sessionProvenance: identity.sessionProvenance }),
          agentArgs: policyOptions.piArgs,
          environment: Object.freeze({ ...context.environment }),
          selection: sessionSelection,
          selectionOverrides: (['majorMode', 'domains', 'profile'] as const).filter((axis) => {
            const flag = axis === 'majorMode' ? '--major-mode' : `--${axis}`;
            return (
              identity.sessionId === resolved.identity.sessionId &&
              resolved.agentArgs.some((arg) => arg === flag || arg.startsWith(`${flag}=`))
            );
          }),
          inheritedSelection: () => {
            const environment = { ...baseEnvironment };
            for (const key of [HARNESS_STATE_POINTER, ...Object.values(HARNESS_STATE_KEYS)]) delete environment[key];
            const defaults = resolveHarnessOptions({
              args: ['--cwd', policyOptions.cwd],
              cwd: policyOptions.cwd,
              environment,
            });
            return { majorMode: defaults.majorMode, domains: defaults.domains, profile: defaults.profile };
          },
          candidates: bundle.descriptor.entries,
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
          facets: pendingSessions.get(sessionOptions.sessionId)?.bundle.facets ?? [],
          workspaceId: sessionOptions.workspaceId,
          workspaceRoot: sessionOptions.repoRoot,
          homeDirectory,
          mountChannel: (channel) => {
            const dispose = hub.registerChannel(channel, { scope: 'session', sessionId: sessionOptions.sessionId });
            return { mounted: true, dispose };
          },
          prepareFacets: host.prepareFacets,
          activateFacets: host.activateFacets,
          canDispatch: host.canDispatch,
          telemetry,
          onNotice: notice,
        });

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
            headers: request.headers,
            ...(body === undefined ? {} : { body }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          }),
        );
      };

      if (!options.noSession) {
        harnessContext = await buildHarnessContext(
          resolveHarnessOptions({ args: resolved.agentArgs, cwd: baseCwd, environment: baseEnvironment }),
          harnessTelemetry,
        );
        const activeHarnessContext = harnessContext;
        try {
          await admitWorkspace(harnessContext.options.repoRoot);
          const initialBundle = await loadComposition(harnessContext.options.repoRoot, 'session', {
            root: harnessContext.options.repoRoot,
            majorMode: harnessContext.options.majorMode,
            activeLayers: harnessContext.selectedLayers,
          });
          pendingSessions.set(resolved.identity.sessionId, {
            cleanup: () => activeHarnessContext.cleanup(),
            bundle: initialBundle,
          });
          await hub.create(sessionHostOptions(harnessContext, initialBundle, resolved.identity));
        } catch (error) {
          pendingSessions.delete(resolved.identity.sessionId);
          await activeHarnessContext.cleanup().catch((cleanupError: unknown) => notice(String(cleanupError)));
          throw error;
        }
        await bounded(harnessTelemetry.flush(), 'initial composition telemetry flush', notice);
      }

      createSession = async (request) => {
        const identity = {
          sessionId: crypto.randomUUID(),
          sessionName: request.name,
          parentSessionId: request.parentSessionId,
          sessionProvenance: request.sessionProvenance,
        };
        const childIdentity = resolveSessionIdentity([], identity);
        const childEnvironment = { ...baseEnvironment };
        for (const key of [HARNESS_STATE_POINTER, ...Object.values(HARNESS_STATE_KEYS)]) delete childEnvironment[key];
        const childContext = await buildHarnessContext(
          resolveHarnessOptions({
            args: ['--cwd', request.cwd, ...childIdentity.agentArgs],
            cwd: request.cwd,
            environment: childEnvironment,
          }),
          harnessTelemetry,
        );
        try {
          await admitWorkspace(childContext.options.repoRoot);
          const bundle = await loadComposition(childContext.options.repoRoot, 'session', {
            root: childContext.options.repoRoot,
            majorMode: childContext.options.majorMode,
            activeLayers: childContext.selectedLayers,
          });
          pendingSessions.set(identity.sessionId, { cleanup: () => childContext.cleanup(), bundle });
          await hub.create(sessionHostOptions(childContext, bundle, identity));
          return { sessionId: identity.sessionId, cwd: childContext.options.cwd };
        } catch (error) {
          pendingSessions.delete(identity.sessionId);
          await childContext.cleanup().catch((cleanupError: unknown) => notice(String(cleanupError)));
          throw error;
        }
      };
    });

    cockpit = await serveHeadlessServer({
      port: options.webPort,
      headlessHub: hub,
      token: attachToken,
      requestAsset: (request) => webCompositions?.request(request) ?? Promise.resolve(undefined),
      compositions: () => ({
        global: webCompositions?.get({ scope: 'global' }),
        publicKey: webCompositions?.publicKey(),
        shell: webCompositions?.shellTrust(),
        workspaces: hub.workspaces().map((workspace) => ({
          ...workspace,
          webComposition: webCompositions?.get({ scope: 'workspace', workspaceId: workspace.id }),
        })),
      }),
      telemetry,
      onNotice: notice,
    });
    notice(`protocol on ${cockpit.url}/api/pi`);
    let resolveShutdown!: (exitCode: number) => void;
    const shutdown = new Promise<number>((resolve) => {
      resolveShutdown = resolve;
    });
    const stop = (): void => resolveShutdown(0);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    try {
      return await shutdown;
    } finally {
      signal.removeEventListener('abort', stop);
    }
  } finally {
    clearInterval(eventLoopMonitor);
    await bounded(telemetry.recordEvent('doompi_server.shutdown'), 'shutdown telemetry', notice);
    await Promise.allSettled([cockpit?.close()]);
    await bounded(remoteRuntime?.close() ?? Promise.resolve(), 'remote control shutdown', notice);
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
    webCompositions?.close();
    const pendingCleanups = [...pendingSessions.values()].map((setup) => setup.cleanup());
    pendingSessions.clear();
    await Promise.allSettled(pendingCleanups);
    await bounded(harnessTelemetry.flush(), 'harness telemetry flush', notice);
    await bounded(harnessTelemetry.shutdown(), 'harness telemetry shutdown', notice);
    await bounded(telemetry.flush(), 'server telemetry flush', notice);
    await bounded(telemetry.shutdown(), 'server telemetry shutdown', notice);
  }
}
