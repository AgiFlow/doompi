import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config/config';
import { filterHookDisabledLayers, loadMajorModesConfig, resolveLayers } from '@agimon-ai/doompi-config/majorModes';
import { createHeadlessHub, type HeadlessHub } from '@agimon-ai/doompi-core/headlessHub';
import { serveHeadlessServer } from '@agimon-ai/doompi-core/headlessServer';
import type { HeadlessSessionHost, HeadlessSessionHostOptions } from '@agimon-ai/doompi-core/headlessSessionHost';
import { createHeadlessSessionManager } from '@agimon-ai/doompi-core/headlessSessionManager';
import {
  createOpenSessionRegistry,
  createWorkspaceRegistry,
  listSavedSessions,
  readSqliteTranscript,
} from '@agimon-ai/doompi-core/history';
import type { OpenSessionRecord } from '@agimon-ai/doompi-core/history';
import type {
  DoomHubSessionApiRequest,
  DoomHubSessionCreateRequest,
  DoomHubSessionScope,
} from '@agimon-ai/doompi-core/hubChannel';
import { loadMcpBundle, type LoadedMcpBundle } from '@agimon-ai/doompi-core/mcpFacet';
import { serveSessionApis, type PackageApiServer } from '@agimon-ai/doompi-core/packageApiServer';
import { piAgentDirectory } from '@agimon-ai/doompi-core/piSettings';
import { createRemoteRuntime, type RemoteRuntime } from '@agimon-ai/doompi-core/remoteRuntime';
import type { HeadlessSessionManager } from '@agimon-ai/doompi-core/runtimeHeadlessSessionManager';
import { createHarnessTelemetry } from '@agimon-ai/doompi-core/runtimeLogSinkTelemetry';
import { loadServerBundle, resolveServerBundleSource } from '@agimon-ai/doompi-core/serverFacet';
import { createServerTelemetry } from '@agimon-ai/doompi-core/serverTelemetry';
import { resolveSyncLocation } from '@agimon-ai/doompi-core/syncLocation';
import { readSyncRegistration } from '@agimon-ai/doompi-core/syncRegistration';
import { createWebCompositions } from '@agimon-ai/doompi-core/webCompositions';
import { readMinorModeCatalog } from '@agimon-ai/doompi-minor-mode';
import WebSocket from 'ws';

import { HARNESS_STATE_KEYS, HARNESS_STATE_POINTER } from '../../composition/harnessState';
import { findRepositoryRoot } from '../../composition/repository';
import { readSyncDrift } from '../../composition/syncDrift';
import { readSyncState } from '../../composition/syncState';
import { buildHarnessContext } from '../cli/harnessContext';
import { publishHeadlessSelectionStatus } from './selectionStatus';
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
  const { cwd: baseCwd, environment: baseEnvironment, notice, resolveHarnessOptions, signal, syncWorkspace } = runtime;
  const telemetry = createServerTelemetry({ cwd: baseCwd, env: baseEnvironment, warn: notice });
  const serverDirectory = path.join(piAgentDirectory(baseEnvironment), 'server');
  const workspaces = createWorkspaceRegistry({ directory: serverDirectory, onNotice: notice });
  // Beside the journals it names, because a record pointing at a sessions
  // directory it is not stored next to is a record that can outlive its target.
  const openSessions = createOpenSessionRegistry({
    directory: serverDirectory,
    onNotice: notice,
  });
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
  type SessionSetup = {
    cleanup: () => Promise<void>;
    bundle: Awaited<ReturnType<typeof loadServerBundle>>;
    mcpBundle: LoadedMcpBundle;
  };
  type SessionArtifacts = SessionSetup & { apis: PackageApiServer };
  const pendingSessions = new Map<string, SessionSetup>();
  const sessionArtifacts = new Map<string, SessionArtifacts>();
  let mountSessionApis:
    | ((options: HeadlessSessionHostOptions, host: HeadlessSessionHost) => Promise<PackageApiServer>)
    | undefined;
  /**
   * Shutdown runs every session through the same close path a user-initiated
   * close uses, so without this the registry would be emptied by the very event
   * it exists to survive.
   */
  let shuttingDown = false;

  const closeManagedSession = async (sessionId: string): Promise<void> => {
    if (!shuttingDown) openSessions.remove(sessionId);
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
  let openSession: (
    request: DoomHubSessionCreateRequest,
    sessionId?: string,
  ) => Promise<DoomHubSessionScope> = async () => {
    throw new Error('The cockpit session service is not ready.');
  };
  let admitWorkspace: (root: string) => Promise<{ id: string; root: string; available: boolean }> = async () => {
    throw new Error('Workspace admission is not ready.');
  };
  let hub!: HeadlessHub;
  hub = createHeadlessHub({
    manager: sessionManager,
    admitWorkspace: (root) => admitWorkspace(root),
    onWorkspaceRemoved: (workspaceId) => {
      workspaces.remove(workspaceId);
      webCompositions?.remove({ scope: 'workspace', workspaceId });
    },
    createSession: (request) => openSession(request),
    sessionReservations: {
      read(id, parentSessionId) {
        if (!cockpit) throw new Error('Session setup is not ready.');
        return cockpit.sessionReservations.read(id, parentSessionId);
      },
      async prepare(id, parentSessionId, cwd) {
        if (!cockpit) throw new Error('Session setup is not ready.');
        return cockpit.sessionReservations.prepare(id, parentSessionId, cwd);
      },
      async complete(id, parentSessionId) {
        if (!cockpit) throw new Error('Session setup is not ready.');
        return cockpit.sessionReservations.complete(id, parentSessionId);
      },
    },
    onNotice: notice,
    hubToken: () => attachToken,
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
      const loadSessionMcp = async (
        root: string,
        selection: { majorMode: string; activeLayers: readonly string[] },
      ): Promise<LoadedMcpBundle> => {
        const registration = readSyncRegistration(root, homeDirectory);
        if (registration?.mcpBundle === undefined)
          throw new Error(`Run the scoped DoomPi sync for '${root}' before opening its MCP runtime.`);
        return loadMcpBundle({
          directory: path.dirname(registration.mcpBundle.path),
          generation: registration.generation,
          fingerprint: registration.mcpBundle.fingerprint,
          descriptorSha256: registration.mcpBundle.sha256,
          majorMode: selection.majorMode,
          activeLayers: selection.activeLayers,
          retainCandidates: true,
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
        readRepositorySync: (id: string) => {
          const root = hub.workspaces().find((workspace) => workspace.id === id)?.root;
          if (!root) return undefined;
          const drift = readSyncDrift({ repoRoot: root, homeDirectory, requireWebBundle: true });
          const state = readSyncState(root, homeDirectory);
          return { ...drift, mcpProjection: state?.fileState.mcpProjection };
        },
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
          return fetch(
            new URL(`${from.pathname}${from.search}`, cockpit.url),
            new Request(request, { headers, redirect: 'manual' }),
          );
        },
        connectProtocol: (pathname) => {
          if (!cockpit || !attachToken) throw new Error('The headless protocol listener is not ready.');
          const url = new URL(pathname, cockpit.url);
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
      const admissions = new Map<string, Promise<{ id: string; root: string; available: boolean }>>();
      admitWorkspace = async (from) => {
        const root = fs.realpathSync(findRepositoryRoot(from));
        const id = resolveSyncLocation(root, homeDirectory).identity.worktreeId;
        const existing = hub.workspaces().find((workspace) => workspace.id === id);
        if (existing !== undefined && existing.available !== false) return { ...existing, available: true };
        const pending = admissions.get(id);
        if (pending) return pending;
        const wasRemembered = workspaces.list().some((workspace) => workspace.id === id);
        if (!wasRemembered) workspaces.add({ id, root });
        hub.registerWorkspace({ id, root, available: false });
        const admission = (async () => {
          const syncEnvironment: NodeJS.ProcessEnv = { ...baseEnvironment, DOOMPI_ROOT: root };
          for (const key of [HARNESS_STATE_POINTER, ...Object.values(HARNESS_STATE_KEYS)]) delete syncEnvironment[key];
          await syncWorkspace(root, syncEnvironment);
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
          return { id, root, available: true };
        })();
        admissions.set(id, admission);
        try {
          return await admission;
        } catch (error) {
          if (!wasRemembered) {
            await hub.removeWorkspace(id);
            workspaces.remove(id);
          }
          throw error;
        } finally {
          admissions.delete(id);
        }
      };
      for (const record of openSessions.list()) {
        if (workspaces.list().some((workspace) => workspace.id === record.workspaceId)) continue;
        try {
          const root = fs.realpathSync(findRepositoryRoot(record.cwd));
          const id = resolveSyncLocation(root, homeDirectory).identity.worktreeId;
          if (id === record.workspaceId) workspaces.add({ id, root });
          else
            notice(
              `Session '${record.sessionId}' no longer resolves to its recorded workspace; skipping registration.`,
            );
        } catch (error) {
          notice(
            `Session '${record.sessionId}' workspace could not be registered: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      for (const workspace of workspaces.list()) {
        hub.registerWorkspace({ ...workspace, available: false });
        try {
          const root = fs.realpathSync(findRepositoryRoot(workspace.root));
          const id = resolveSyncLocation(root, homeDirectory).identity.worktreeId;
          if (root !== workspace.root || id !== workspace.id) {
            notice(
              `Workspace '${workspace.root}' no longer resolves to its recorded identity; leaving it unavailable.`,
            );
            continue;
          }
          await admitWorkspace(workspace.root);
        } catch (error) {
          notice(
            `Workspace '${workspace.root}' could not be restored: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const sessionHostOptions = (
        context: Awaited<ReturnType<typeof buildHarnessContext>>,
        bundle: Awaited<ReturnType<typeof loadServerBundle>>,
        mcpBundle: LoadedMcpBundle,
        identity: {
          sessionId: string;
          sessionName: string;
          parentSessionId?: string;
          sessionProvenance?: string;
        },
        workspaceId?: string,
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
          workspaceId: workspaceId ?? resolveSyncLocation(policyOptions.repoRoot, homeDirectory).identity.worktreeId,
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
          mcpPlugins: mcpBundle.plugins,
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
          pluginRegistry: hub.pluginRegistry,
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
          new Request(`http://doompi.local/api/plugins/${request.basePath}${request.path}`, {
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
          const initialMcpBundle = await loadSessionMcp(harnessContext.options.repoRoot, {
            majorMode: harnessContext.options.majorMode,
            activeLayers: harnessContext.selectedLayers,
          });
          pendingSessions.set(resolved.identity.sessionId, {
            cleanup: () => activeHarnessContext.cleanup(),
            bundle: initialBundle,
            mcpBundle: initialMcpBundle,
          });
          await hub.create(sessionHostOptions(harnessContext, initialBundle, initialMcpBundle, resolved.identity));
        } catch (error) {
          pendingSessions.delete(resolved.identity.sessionId);
          await activeHarnessContext.cleanup().catch((cleanupError: unknown) => notice(String(cleanupError)));
          throw error;
        }
        await bounded(harnessTelemetry.flush(), 'initial composition telemetry flush', notice);
      }

      const reservedOpens = new Map<string, Promise<DoomHubSessionScope>>();
      openSession = async (request, sessionId) => {
        request.signal?.throwIfAborted();
        if (request.reservationId !== undefined) {
          if (!request.parentSessionId || !cockpit) throw new Error('A reserved session requires its owning parent.');
          const prepared = await cockpit.sessionReservations.prepare(
            request.reservationId,
            request.parentSessionId,
            request.cwd,
          );
          if (sessionId !== undefined && sessionId !== prepared.sessionId)
            throw new Error('Reserved session identity cannot change.');
          sessionId = prepared.sessionId;
          const existing = hub.session(sessionId);
          if (existing) {
            if (existing.cwd !== prepared.cwd || existing.parentSessionId !== request.parentSessionId)
              throw new Error('Reserved session target does not match.');
            return { sessionId, cwd: existing.cwd, workspaceId: existing.workspaceId };
          }
          if (openSessions.list().some((record) => record.sessionId === sessionId))
            throw new Error('Resume the recorded session instead of recreating it.');
          const pending = reservedOpens.get(sessionId);
          if (pending) return pending;
          request = { ...request, cwd: prepared.cwd };
        }
        const identity = {
          sessionId: sessionId ?? crypto.randomUUID(),
          sessionName: request.name,
          parentSessionId: request.parentSessionId,
          sessionProvenance: request.sessionProvenance,
        };
        const inheritedWorkspaceId =
          request.sessionProvenance === 'worktree' && request.parentSessionId
            ? (hub.session(request.parentSessionId)?.workspaceId ??
              openSessions.list().find((record) => record.sessionId === request.parentSessionId)?.workspaceId)
            : undefined;
        if (request.sessionProvenance === 'worktree' && inheritedWorkspaceId === undefined)
          throw new Error('Worktree session requires its parent workspace.');
        const start = (async (): Promise<DoomHubSessionScope> => {
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
            if (inheritedWorkspaceId === undefined) {
              await admitWorkspace(childContext.options.repoRoot);
            } else {
              const inheritedWorkspace = hub
                .workspaces()
                .find((workspace) => workspace.id === inheritedWorkspaceId && workspace.available !== false);
              if (inheritedWorkspace === undefined) throw new Error('Worktree parent workspace is unavailable.');
              const syncEnvironment: NodeJS.ProcessEnv = {
                ...baseEnvironment,
                DOOMPI_ROOT: childContext.options.repoRoot,
              };
              for (const key of [HARNESS_STATE_POINTER, ...Object.values(HARNESS_STATE_KEYS)])
                delete syncEnvironment[key];
              await syncWorkspace(childContext.options.repoRoot, syncEnvironment);
            }
            const bundle = await loadComposition(childContext.options.repoRoot, 'session', {
              root: childContext.options.repoRoot,
              majorMode: childContext.options.majorMode,
              activeLayers: childContext.selectedLayers,
            });
            const mcpBundle = await loadSessionMcp(childContext.options.repoRoot, {
              majorMode: childContext.options.majorMode,
              activeLayers: childContext.selectedLayers,
            });
            request.signal?.throwIfAborted();
            pendingSessions.set(identity.sessionId, { cleanup: () => childContext.cleanup(), bundle, mcpBundle });
            const created = await hub.create(
              sessionHostOptions(childContext, bundle, mcpBundle, identity, inheritedWorkspaceId),
            );
            request.signal?.throwIfAborted();
            if (created.workspaceId !== undefined) {
              const saved = openSessions.add({
                sessionId: created.id,
                workspaceId: created.workspaceId,
                cwd: created.cwd,
                name: created.name,
                createdAt: created.createdAt,
                ...(created.parentSessionId === undefined ? {} : { parentSessionId: created.parentSessionId }),
                ...(created.sessionProvenance === undefined ? {} : { sessionProvenance: created.sessionProvenance }),
              });
              if (saved === false) throw new Error('The new session could not be durably recorded.');
            }
            return { sessionId: identity.sessionId, cwd: childContext.options.cwd, workspaceId: created.workspaceId };
          } catch (error) {
            if (hub.session(identity.sessionId)) await hub.closeSession(identity.sessionId);
            else {
              pendingSessions.delete(identity.sessionId);
              await childContext.cleanup().catch((cleanupError: unknown) => notice(String(cleanupError)));
            }
            throw error;
          }
        })();
        if (request.reservationId !== undefined) reservedOpens.set(identity.sessionId, start);
        try {
          return await start;
        } finally {
          if (reservedOpens.get(identity.sessionId) === start) reservedOpens.delete(identity.sessionId);
        }
      };
    });

    const workspaceResumes = new Map<string, Promise<string>>();
    cockpit = await serveHeadlessServer({
      port: options.webPort,
      headlessHub: hub,
      token: attachToken,
      sessionMcpPublicOrigin: () => remoteRuntime?.remote.publicOrigin(),
      sessionMcpStateDir: serverDirectory,
      sessionMcpPublicOriginRevision: () => remoteRuntime?.remote.publicOriginRevision() ?? 0,
      isSessionPersisted: (sessionId, cwd) =>
        openSessions.list().some((record) => record.sessionId === sessionId && record.cwd === cwd),
      workspaceHistory: (workspaceId) => {
        const workspaceRoot = hub
          .workspaces()
          .find((workspace) => workspace.id === workspaceId && workspace.available !== false)?.root;
        if (!workspaceRoot) throw new Error('Workspace not found.');
        return listSavedSessions(
          path.join(serverDirectory, 'sessions'),
          workspaceRoot,
          new Set(hub.snapshot().map((active) => active.id)),
        );
      },
      resumeWorkspaceSession: async (workspaceId, targetSessionId) => {
        const key = `${workspaceId}\0${targetSessionId}`;
        const pending = workspaceResumes.get(key);
        if (pending) return pending;
        const resume = (async () => {
          const workspaceRoot = hub
            .workspaces()
            .find((workspace) => workspace.id === workspaceId && workspace.available !== false)?.root;
          if (!workspaceRoot) throw new Error('Workspace not found.');
          const saved = await listSavedSessions(
            path.join(serverDirectory, 'sessions'),
            workspaceRoot,
            new Set(hub.snapshot().map((active) => active.id)),
          );
          const target = saved.find((item) => item.id === targetSessionId);
          if (!target) throw new Error('Saved Pi thread not found in this workspace.');
          await openSession({ cwd: workspaceRoot, name: target.name ?? 'untitled' }, target.id);
          return target.id;
        })();
        workspaceResumes.set(key, resume);
        try {
          return await resume;
        } finally {
          workspaceResumes.delete(key);
        }
      },
      sessionHistory: (session) => {
        const workspaceRoot = hub.workspaces().find((workspace) => workspace.id === session.workspaceId)?.root;
        if (!workspaceRoot) throw new Error('Session workspace not found.');
        return listSavedSessions(
          path.join(piAgentDirectory(baseEnvironment), 'server', 'sessions'),
          workspaceRoot,
          new Set(hub.snapshot().map((active) => active.id)),
        );
      },
      readDormantTranscript: (record, request, context) => {
        const workspaceRoot = hub.workspaces().find((workspace) => workspace.id === record.workspaceId)?.root;
        if (!workspaceRoot) throw new Error('Saved transcript unavailable.');
        return readSqliteTranscript(
          path.join(piAgentDirectory(baseEnvironment), 'server', 'sessions', `${record.sessionId}.sqlite`),
          request,
          context,
          { sessionId: record.sessionId, workspaceRoot },
        );
      },
      restartSession: async (session) => {
        const workspaceRoot = hub.workspaces().find((workspace) => workspace.id === session.workspaceId)?.root;
        if (!workspaceRoot) throw new Error('Session workspace not found.');
        const syncEnvironment: NodeJS.ProcessEnv = { ...baseEnvironment, DOOMPI_ROOT: workspaceRoot };
        for (const key of [HARNESS_STATE_POINTER, ...Object.values(HARNESS_STATE_KEYS)]) delete syncEnvironment[key];
        try {
          await syncWorkspace(workspaceRoot, syncEnvironment);
        } catch (error) {
          notice(`Workspace sync failed before restart: ${error instanceof Error ? error.message : String(error)}`);
          throw new Error('Workspace sync failed; the session is still running.', { cause: error });
        }
        await hub.closeSession(session.id);
        await openSession(
          {
            cwd: session.cwd,
            name: session.name,
            ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
            ...(session.sessionProvenance === undefined ? {} : { sessionProvenance: session.sessionProvenance }),
          },
          session.id,
        );
      },
      resumeSession: async (session, targetSessionId) => {
        const workspaceRoot = hub.workspaces().find((workspace) => workspace.id === session.workspaceId)?.root;
        if (!workspaceRoot) throw new Error('Session workspace not found.');
        const saved = await listSavedSessions(
          path.join(piAgentDirectory(baseEnvironment), 'server', 'sessions'),
          workspaceRoot,
          new Set(hub.snapshot().map((active) => active.id)),
        );
        const target = saved.find((item) => item.id === targetSessionId);
        if (!target) throw new Error('Saved Pi thread not found in this workspace.');
        await hub.closeSession(session.id);
        await openSession({ cwd: session.cwd, name: target.name ?? 'untitled' }, target.id);
        return target.id;
      },
      dormantSessions: () => openSessions.list(),
      removeDormantSession: (record: OpenSessionRecord) => openSessions.remove(record.sessionId),
      reviveSession: async (record: OpenSessionRecord) => {
        // A failed wake may be transient, for example while another server still
        // owns the journal. Keep the record so the user can retry after resolving
        // the conflict instead of losing the session from the cockpit.
        await openSession(
          {
            cwd: record.cwd,
            name: record.name,
            ...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
            ...(record.sessionProvenance === undefined ? {} : { sessionProvenance: record.sessionProvenance }),
          },
          record.sessionId,
        );
      },
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
    notice(`protocol on ${cockpit.url}/api/ws`);
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
    shuttingDown = true;
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
