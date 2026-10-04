import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { globalDoomConfigDirectory } from '@agimon-ai/doompi-config/config';
import { filterHookDisabledLayers, loadMajorModesConfig, resolveLayers } from '@agimon-ai/doompi-config/majorModes';
import { resolveProfile } from '@agimon-ai/doompi-config/profiles';
import { createHeadlessHub, type HeadlessHub } from '@agimon-ai/doompi-core/headlessHub';
import { serveHeadlessServer } from '@agimon-ai/doompi-core/headlessServer';
import type { HeadlessSessionHost, HeadlessSessionHostOptions } from '@agimon-ai/doompi-core/headlessSessionHost';
import { createHeadlessSessionManager } from '@agimon-ai/doompi-core/headlessSessionManager';
import {
  createOpenSessionRegistry,
  createRequestReceipts,
  createWorkspaceRegistry,
  identifyWorkspace,
  listSavedSessionRecords,
  listSavedSessions,
  readSqliteTranscript,
  readWorkspaceMarker,
  writeWorkspaceMarker,
} from '@agimon-ai/doompi-core/history';
import type { OpenSessionRecord, SavedSessionExecution } from '@agimon-ai/doompi-core/history';
import type {
  DoomHubSessionApiRequest,
  DoomHubSessionCreateRequest,
  DoomHubSessionScope,
} from '@agimon-ai/doompi-core/hubChannel';
import { loadMcpBundle, type LoadedMcpBundle } from '@agimon-ai/doompi-core/mcpFacet';
import { createServerExecutionBudget } from '@agimon-ai/doompi-core/packageApi';
import type { DoomHostMediaArbitration, DoomPeerAgentRegistry } from '@agimon-ai/doompi-core/packageApi';
import { serveSessionApis, type PackageApiServer } from '@agimon-ai/doompi-core/packageApiServer';
import { piAgentDirectory } from '@agimon-ai/doompi-core/piSettings';
import { createRemoteRuntime, type RemoteRuntime } from '@agimon-ai/doompi-core/remoteRuntime';
import type {
  HeadlessSessionCloseOptions,
  HeadlessSessionManager,
} from '@agimon-ai/doompi-core/runtimeHeadlessSessionManager';
import { createHarnessTelemetry } from '@agimon-ai/doompi-core/runtimeLogSinkTelemetry';
import { loadServerBundle, resolveServerBundleSource } from '@agimon-ai/doompi-core/serverFacet';
import { createServerTelemetry } from '@agimon-ai/doompi-core/serverTelemetry';
import { resolveSyncLocation } from '@agimon-ai/doompi-core/syncLocation';
import {
  parseSyncRegistration,
  readSyncRegistration,
  validateSyncRegistration,
  type SyncRegistration,
} from '@agimon-ai/doompi-core/syncRegistration';
import { createWebCompositions } from '@agimon-ai/doompi-core/webCompositions';
import { readMinorModeCatalog } from '@agimon-ai/doompi-minor-mode';
import WebSocket from 'ws';

import { HARNESS_STATE_KEYS, HARNESS_STATE_POINTER, updateHarnessState } from '../../composition/harnessState';
import { findRepositoryRoot } from '../../composition/repository';
import { readSyncDrift } from '../../composition/syncDrift';
import { readSyncState, readRegisteredSyncState } from '../../composition/syncState';
import { readRegisteredBootstrapStatus } from '../cli/bootstrapLocator';
import { buildHarnessContext } from '../cli/harnessContext';
import { validateHookModules } from '../hooks';
import { createComputerUseBinding } from './computerUseBinding';
import { createDefaultWorkspaceFolder } from './defaultWorkspace';
import { ensureGlobalLogSink } from './logSink';
import { monitorRuntimeResources } from './runtimeResources';
import { publishHeadlessSelectionStatus } from './selectionStatus';
import { type PinnedSelectionAxis, resolveSessionIdentity, sessionSelectionArgs } from './sessionArguments';
import { resolveSessionArtifact, resolveWorktreeRestart } from './sessionArtifact';
import { withShutdownDeadline } from './shutdown';
import type { ServeOptions, ServerRuntimeEnvironment } from './types';
import { checkoutWorkspaceId } from './workspaceCheckout';

async function bounded(operation: Promise<unknown>, label: string, notice: (message: string) => void): Promise<void> {
  try {
    await withShutdownDeadline(() => operation, label);
  } catch (error) {
    notice(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function runServerRuntime(options: ServeOptions, runtime: ServerRuntimeEnvironment): Promise<number> {
  const {
    cwd: baseCwd,
    environment: incomingEnvironment,
    notice,
    resolveHarnessOptions,
    signal,
    syncWorkspace,
  } = runtime;
  // Keep this selection local to this server and its admitted sessions. The
  // process environment may also serve unrelated hosts and must not be changed.
  const baseEnvironment: NodeJS.ProcessEnv = { ...incomingEnvironment, LOG_SINK_INSTANCE: 'global' };
  const executionBudget = createServerExecutionBudget(baseEnvironment);
  await ensureGlobalLogSink({ cwd: baseCwd, env: baseEnvironment, notice }).catch((error: unknown) =>
    notice(`Global log sink unavailable: ${error instanceof Error ? error.message : String(error)}`),
  );
  const telemetry = createServerTelemetry({ cwd: baseCwd, env: baseEnvironment, warn: notice });
  const homeDirectory = baseEnvironment.HOME ?? os.homedir();
  const serverDirectory = path.join(piAgentDirectory(baseEnvironment), 'server');
  // This native history has no agent lane and is deliberately outside the session-history catalog.
  const requestReceipts = createRequestReceipts({ directory: path.join(serverDirectory, 'request-receipts-v1') });
  const activeMedia = new Set<() => boolean>();
  const mediaArbitration: DoomHostMediaArbitration = {
    register(busy) {
      activeMedia.add(busy);
      return () => {
        activeMedia.delete(busy);
      };
    },
    available(busy) {
      return activeMedia.has(busy) && [...activeMedia].every((other) => other === busy || !other());
    },
  };
  const activePeerAgents = new Map<string, { fetch(request: Request): Promise<Response>; hubToken: string }>();
  const peerAgents: DoomPeerAgentRegistry = {
    register(sessionId, agent, hubToken) {
      if (activePeerAgents.has(sessionId)) throw new Error(`Voice peer agent '${sessionId}' is already registered.`);
      const entry = { fetch: (request: Request) => agent.fetch(request), hubToken };
      activePeerAgents.set(sessionId, entry);
      return () => {
        if (activePeerAgents.get(sessionId) === entry) activePeerAgents.delete(sessionId);
      };
    },
    get: (sessionId) => activePeerAgents.get(sessionId),
  };
  const workspaces = createWorkspaceRegistry({ directory: serverDirectory, onNotice: notice });
  // Beside the journals it names, because a record pointing at a sessions
  // directory it is not stored next to is a record that can outlive its target.
  const openSessions = createOpenSessionRegistry({
    directory: serverDirectory,
    homeDirectory,
    onNotice: notice,
  });
  let lastBudgetSnapshot = '';
  let nextEventLoopTick = performance.now() + 1_000;
  const eventLoopMonitor = setInterval(() => {
    const now = performance.now();
    const budget = executionBudget.getSnapshot();
    const snapshot = JSON.stringify(budget);
    if (snapshot !== lastBudgetSnapshot) {
      lastBudgetSnapshot = snapshot;
      void telemetry
        .recordEvent('doompi_server.execution_budget', {
          host_pid: process.pid,
          running_jobs: budget.running,
          queued_jobs: budget.queued,
          limit: budget.limit,
        })
        .catch((error: unknown) => notice(`execution budget telemetry failed: ${String(error)}`));
    }
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
    registration: SyncRegistration;
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

  const closeManagedSession = async (sessionId: string, options?: HeadlessSessionCloseOptions): Promise<void> => {
    // A released session keeps its record, which is what lists it as dormant.
    if (!shuttingDown && options?.keepDormant !== true) openSessions.remove(sessionId);
    const artifacts = sessionArtifacts.get(sessionId);
    sessionArtifacts.delete(sessionId);
    webCompositions?.remove({ scope: 'session', sessionId });
    const failures: unknown[] = [];
    // The host goes first, as on the create-failure path: it stops the running turn and
    // dispatches session_shutdown while the facets that own those hooks are still installed.
    try {
      await withShutdownDeadline(
        () => baseSessionManager.closeSession(sessionId),
        `Session '${sessionId}' runtime shutdown`,
      );
    } catch (error) {
      failures.push(error);
    }
    try {
      await withShutdownDeadline(() => artifacts?.apis.close(), `Session '${sessionId}' API shutdown`);
    } catch (error) {
      failures.push(error);
    }
    try {
      await withShutdownDeadline(() => artifacts?.cleanup(), `Session '${sessionId}' artifact cleanup`);
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
    pinnedArtifact?: SyncRegistration,
    groupingWorkspaceId?: string,
  ) => Promise<DoomHubSessionScope> = async () => {
    throw new Error('The cockpit session service is not ready.');
  };
  let admitWorkspace: (
    root: string,
    name?: string,
  ) => Promise<{ id: string; root: string; name?: string; available: boolean }> = async () => {
    throw new Error('Workspace admission is not ready.');
  };
  let remoteRuntime: RemoteRuntime | undefined;
  const computerUse = await createComputerUseBinding(process, {
    isDeviceAuthorized: (id) => remoteRuntime?.remote.isDeviceAuthorized(id) === true,
    stepUpRequired: () => remoteRuntime?.remote.stepUpRequired('computer-use.activate') === true,
  });
  let hub!: HeadlessHub;
  hub = createHeadlessHub({
    manager: sessionManager,
    // Throws for an unknown profile; the hub reports that and shows the session without an avatar.
    resolveProfileIdentity: (root, profile) => {
      const identity = resolveProfile(root, profile, homeDirectory).identity;
      return identity === undefined ? undefined : { displayName: identity.name, icon: identity.icon };
    },
    admitWorkspace: async ({ root, name }) =>
      admitWorkspace(
        root === undefined || root.trim() === '' ? await createDefaultWorkspaceFolder(name ?? '', homeDirectory) : root,
        name,
      ),
    onWorkspaceRemoved: (workspaceId) => {
      workspaces.remove(workspaceId);
      webCompositions?.remove({ scope: 'workspace', workspaceId });
    },
    createSession: async (request, placement) => {
      if (placement === undefined) return openSession(request);
      // A workspace package's top-level session must run in a checkout of that same workspace.
      if (checkoutWorkspaceId(workspaces.list(), request.cwd) !== placement.workspaceId)
        throw new Error('The session directory is outside this workspace.');
      return openSession(request, undefined, undefined, placement.workspaceId);
    },
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
    ...(computerUse === undefined ? {} : { computerUse }),
  });
  const stopPersistSessionNames = hub.onEvent((event) => {
    if (event.kind !== 'upsert') return;
    const record = openSessions.list().find((entry) => entry.sessionId === event.session.id);
    if (record === undefined || record.name === event.session.name) return;
    openSessions.add({ ...record, name: event.session.name });
  });
  let harnessContext: Awaited<ReturnType<typeof buildHarnessContext>> | undefined;
  let cockpit: Awaited<ReturnType<typeof serveHeadlessServer>> | undefined;
  let attachToken: string | undefined;
  let webCompositions: ReturnType<typeof createWebCompositions> | undefined;
  const stopResourceMonitor = monitorRuntimeResources({
    record: (attributes) => telemetry.recordEvent('doompi_server.resources', attributes),
    counts: () => {
      const budget = executionBudget.getSnapshot();
      return {
        sessions: sessionManager.sessions().length,
        running_jobs: budget.running,
        queued_jobs: budget.queued,
        job_limit: budget.limit,
      };
    },
    warn: notice,
  });

  try {
    await telemetry.runInSpan('doompi_server.startup', {}, async () => {
      const token = fs.readFileSync(options.tokenFile, 'utf8').trim();
      if (!token) throw new Error('The attach token file is empty.');
      attachToken = token;

      const resolved = resolveSessionIdentity(options.agentArgs, {
        sessionId: options.sessionId ?? crypto.randomUUID(),
        sessionName: options.sessionName,
      });

      const globalRoot = globalDoomConfigDirectory(homeDirectory);
      webCompositions = createWebCompositions(path.join(globalRoot, 'server'), notice);
      const loadComposition = async (
        root: string,
        scope: 'global' | 'workspace' | 'session',
        selection?: { root: string; majorMode: string; activeLayers: string[] },
        pinnedRegistration?: SyncRegistration,
      ) => {
        const registration = pinnedRegistration ?? readSyncRegistration(root, homeDirectory);
        const source = resolveServerBundleSource({ registration });
        if (source.kind !== 'descriptor')
          throw new Error(`Run the scoped DoomPi sync for '${root}' before opening it.`);
        const selected =
          selection ??
          (() => {
            const config = loadMajorModesConfig(root, homeDirectory, baseEnvironment);
            const majorMode = config.defaultMajorMode;
            return { root, majorMode, activeLayers: resolveLayers(config, majorMode) };
          })();
        return telemetry.runInSpan('doompi_server.composition_load', { scope }, () =>
          loadServerBundle(scope, {
            ...source,
            ...selected,
            retainCandidates: scope === 'session',
            onNotice: notice,
          }),
        );
      };
      const loadSessionMcp = async (
        root: string,
        selection: { majorMode: string; activeLayers: readonly string[] },
        pinnedRegistration?: SyncRegistration,
      ): Promise<LoadedMcpBundle> => {
        const registration = pinnedRegistration ?? readSyncRegistration(root, homeDirectory);
        if (registration?.mcpBundle === undefined)
          throw new Error(`Run the scoped DoomPi sync for '${root}' before opening its MCP runtime.`);
        const bundle = registration.mcpBundle;
        return telemetry.runInSpan('doompi_server.mcp_bundle_load', {}, () =>
          loadMcpBundle({
            directory: path.dirname(bundle.path),
            generation: registration.generation,
            fingerprint: bundle.fingerprint,
            descriptorSha256: bundle.sha256,
            majorMode: selection.majorMode,
            activeLayers: selection.activeLayers,
            retainCandidates: true,
            onNotice: notice,
          }),
        );
      };
      const sharedApiContext = {
        homeDirectory,
        environment: baseEnvironment,
        hubToken: token,
        sessionService: hub.sessionService,
        mediaArbitration,
        executionBudget,
        peerAgents,
        directEvents: hub.directEvents,
        requestApi: (mount: Parameters<HeadlessHub['requestApi']>[0], basePath: string, request: Request) =>
          hub.requestApi(mount, basePath, request),
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
          const drift = readSyncDrift({
            repoRoot: root,
            environment: baseEnvironment,
            homeDirectory,
            requireWebBundle: true,
          });
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
        onDeviceDropped: (id) => computerUse?.revokeDevice?.(id),
        reservedPorts: () => [options.webPort],
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
        connectProtocol: (pathname, deviceId) => {
          if (!cockpit || !attachToken) throw new Error('The headless protocol listener is not ready.');
          const url = new URL(pathname, cockpit.url);
          url.protocol = 'ws:';
          return new WebSocket(url, {
            headers: {
              'x-doompi-token': attachToken,
              ...(deviceId === undefined
                ? {}
                : {
                    'x-doompi-api-caller-locality': 'remote',
                    'x-doompi-api-caller-device-id': deviceId,
                    'x-doompi-api-caller-step-up': 'not-required',
                  }),
            },
          });
        },
      });
      await hub.mountFacets(globalBundle.facets, {
        ...sharedApiContext,
        scope: 'global',
        requestReceipts: requestReceipts.receipts,
        remoteControl: { fetch: (request: Request) => remoteRuntime!.fetchLocal(request) },
      });
      webCompositions.publish(
        { scope: 'global' },
        readSyncRegistration(globalRoot, homeDirectory)!,
        hub.channelTypes(),
      );
      const admissions = new Map<string, Promise<{ id: string; root: string; name?: string; available: boolean }>>();
      // A member checkout is any checkout other than its workspace root, such as a worktree.
      const isMemberCheckout = (from: string, workspace: { root: string }): boolean =>
        fs.realpathSync(findRepositoryRoot(from)) !== workspace.root;
      admitWorkspace = async (from, requestedName) => {
        const checkoutRoot = fs.realpathSync(findRepositoryRoot(from));
        // Ids are persisted, never re-derived from the path: a checkout of an admitted repository
        // joins its workspace, and a repository that moved keeps its id and sessions.
        const { id, root, moved } = identifyWorkspace({
          records: workspaces.list(),
          checkoutRoot,
          marker: readWorkspaceMarker(checkoutRoot),
        });
        const record = workspaces.list().find((workspace) => workspace.id === id);
        // A name given now replaces the stored one; readmitting without a name keeps it.
        const name = requestedName?.trim() || record?.name;
        const named = name === undefined ? {} : { name };
        const renamed = record !== undefined && name !== record.name;
        const existing = hub.workspaces().find((workspace) => workspace.id === id);
        if (existing !== undefined && existing.available !== false && existing.root === root) {
          if (renamed) {
            workspaces.add({ id, root, ...named });
            hub.registerWorkspace({ ...existing, ...named, available: true });
          }
          return { ...existing, ...named, available: true };
        }
        const pending = admissions.get(id);
        if (pending) return pending;
        const wasRemembered = record !== undefined;
        if (!wasRemembered || moved || renamed) workspaces.add({ id, root, ...named });
        if (moved) notice(`Workspace '${id}' moved to '${root}'.`);
        hub.registerWorkspace({ id, root, ...named, available: false });
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
          try {
            if (readWorkspaceMarker(root) === undefined) writeWorkspaceMarker(root, id);
          } catch (error) {
            notice(
              `Workspace '${root}' id could not be recorded in its git data: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          return { id, root, ...named, available: true };
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
          const candidate = record.groupingRoot ?? record.artifact?.root ?? record.cwd;
          const root = fs.realpathSync(findRepositoryRoot(candidate));
          // The recorded id is kept as is. It may be a legacy path hash, and journals, open-session
          // records and MCP audiences all refer to it.
          if (
            (record.groupingRoot === undefined || root === candidate) &&
            !workspaces.list().some((workspace) => workspace.root === root)
          )
            workspaces.add({ id: record.workspaceId, root });
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
          if (root !== workspace.root) {
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
        registration: SyncRegistration,
        identity: {
          sessionId: string;
          sessionName: string;
          parentSessionId?: string;
          sessionProvenance?: string;
        },
        workspace: { id: string; root: string },
        explicit: {
          pinned: readonly PinnedSelectionAxis[];
          minorModes?: readonly string[];
          allowedTools?: readonly string[];
          initialFastMode?: boolean;
        } = { pinned: [] },
      ): HeadlessSessionHostOptions => {
        const policyOptions = context.options;
        const sessionSelection = {
          root: policyOptions.repoRoot,
          majorMode: policyOptions.majorMode,
          activeLayers: context.selectedLayers,
          domains: policyOptions.domains,
          profile: context.profile,
          state: { 'minor-mode': [...(explicit.minorModes ?? [])] },
        };
        const piBootstrap = readRegisteredBootstrapStatus(registration, undefined, homeDirectory);
        if (!piBootstrap.fresh || piBootstrap.bootstrap === undefined) {
          throw new Error(`The admitted DoomPi bootstrap for generation '${registration.generation}' is unavailable.`);
        }
        // Read the admitted registration, not the repository's moving current pointer.
        const hookModules = readRegisteredSyncState(registration, homeDirectory).fileState.hookModules;
        updateHarnessState({ hookModules }, context.environment);
        return {
          cwd: policyOptions.cwd,
          repoRoot: policyOptions.repoRoot,
          sessionId: identity.sessionId,
          workspaceId: workspace.id,
          groupingRoot: workspace.root,
          // A member checkout runs its workspace's compiled composition, not one of its own.
          ...(isMemberCheckout(policyOptions.repoRoot, workspace) ? { inheritedArtifact: registration } : {}),
          sessionName: identity.sessionName,
          ...(explicit.initialFastMode === undefined ? {} : { initialFastMode: explicit.initialFastMode }),
          webComposition: webCompositions?.publish(
            { scope: 'session', sessionId: identity.sessionId },
            registration,
            hub.channelTypes(),
          ),
          ...(identity.parentSessionId === undefined ? {} : { parentSessionId: identity.parentSessionId }),
          ...(identity.sessionProvenance === undefined ? {} : { sessionProvenance: identity.sessionProvenance }),
          agentArgs: policyOptions.piArgs,
          environment: Object.freeze({ ...context.environment }),
          piExtensionPaths: [piBootstrap.bootstrap],
          selection: sessionSelection,
          ...(explicit.allowedTools === undefined ? {} : { allowedTools: explicit.allowedTools }),
          selectionOverrides: (['majorMode', 'domains', 'profile'] as const).filter((axis) => {
            if (explicit.pinned.includes(axis)) return true;
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
              ...(policyOptions.configRoot === undefined ? {} : { configRoot: policyOptions.configRoot }),
            });
            return { majorMode: defaults.majorMode, domains: defaults.domains, profile: defaults.profile };
          },
          candidates: bundle.descriptor.entries,
          mcpPlugins: mcpBundle.plugins,
          resolveSelection: (requested) => {
            const config = loadMajorModesConfig(
              policyOptions.configRoot ?? policyOptions.repoRoot,
              policyOptions.homeDirectory,
              policyOptions.environment ?? baseEnvironment,
            );
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
          requestApi: (mount, basePath, request) => hub.requestApi(mount, basePath, request),
          publishActivity: (activity) => hub.setSessionActivity?.(sessionOptions.sessionId, activity),
          ...(computerUse === undefined
            ? {}
            : {
                computerUse: {
                  get available() {
                    return computerUse.available;
                  },
                  get enabled() {
                    return computerUse.enabled === true;
                  },
                  authorize: (headers: Headers) =>
                    computerUse.authorizeSession?.(sessionOptions.sessionId, headers) === true ||
                    computerUse.authorize?.(headers) === true,
                  authorizeRecording: (headers: Headers) =>
                    computerUse.authorizeRecording?.(sessionOptions.sessionId, headers) === true,
                  authorizeActivation: (headers: Headers) => computerUse.authorizeActivation?.(headers) === true,
                  claim: (headers?: Headers) => computerUse.claimSession?.(sessionOptions.sessionId, headers),
                  fetchRecording: (artifactId: string, range: string) =>
                    computerUse.readRecording?.(
                      { sessionId: sessionOptions.sessionId, cwd: sessionOptions.cwd },
                      artifactId,
                      range,
                    ) ?? Promise.resolve(Response.json({ error: 'Not found.' }, { status: 404 })),
                  subscribe: (listener: () => void) =>
                    computerUse.subscribe?.(listener, sessionOptions.sessionId) ?? (() => undefined),
                },
              }),
          hubToken: token,
          sessionService: hub.sessionService,
          mediaArbitration,
          executionBudget,
          peerAgents,
          pluginRegistry: hub.pluginRegistry,
          apis: [],
          facets: pendingSessions.get(sessionOptions.sessionId)?.bundle.facets ?? [],
          workspaceId: sessionOptions.workspaceId,
          // The checkout, which MCP authorizes against; sessionContext carries both roots.
          workspaceRoot: sessionOptions.repoRoot,
          ...(host.sessionContext === undefined ? {} : { sessionContext: host.sessionContext }),
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
        const initialOptions = resolveHarnessOptions({
          args: resolved.agentArgs,
          cwd: baseCwd,
          environment: baseEnvironment,
        });
        const initialWorkspace = await admitWorkspace(initialOptions.repoRoot);
        if (!isMemberCheckout(initialOptions.repoRoot, initialWorkspace)) {
          const syncEnvironment: NodeJS.ProcessEnv = { ...baseEnvironment, DOOMPI_ROOT: initialWorkspace.root };
          for (const key of [HARNESS_STATE_POINTER, ...Object.values(HARNESS_STATE_KEYS)]) delete syncEnvironment[key];
          await syncWorkspace(initialWorkspace.root, syncEnvironment);
        }
        const initialRegistration = readSyncRegistration(initialWorkspace.root, homeDirectory);
        if (initialRegistration === undefined)
          throw new Error(`Run the scoped DoomPi sync for '${initialWorkspace.root}' before opening it.`);
        harnessContext = await buildHarnessContext(
          resolveHarnessOptions({ args: resolved.agentArgs, cwd: baseCwd, environment: baseEnvironment }),
          harnessTelemetry,
        );
        const activeHarnessContext = harnessContext;
        try {
          if (harnessContext.options.hooks)
            await validateHookModules({
              repoRoot: harnessContext.options.repoRoot,
              homeDirectory,
              hookGroups: harnessContext.hookGroups,
              descriptor: readRegisteredSyncState(initialRegistration, homeDirectory).fileState.hookModules,
              isSubagent: Boolean(baseEnvironment.PI_SUBAGENT_CHILD),
            });
          const initialBundle = await loadComposition(
            harnessContext.options.repoRoot,
            'session',
            {
              root: harnessContext.options.repoRoot,
              majorMode: harnessContext.options.majorMode,
              activeLayers: harnessContext.selectedLayers,
            },
            initialRegistration,
          );
          const initialMcpBundle = await loadSessionMcp(
            harnessContext.options.repoRoot,
            {
              majorMode: harnessContext.options.majorMode,
              activeLayers: harnessContext.selectedLayers,
            },
            initialRegistration,
          );
          pendingSessions.set(resolved.identity.sessionId, {
            cleanup: () => activeHarnessContext.cleanup(),
            bundle: initialBundle,
            mcpBundle: initialMcpBundle,
            registration: initialRegistration,
          });
          await hub.create(
            sessionHostOptions(
              harnessContext,
              initialBundle,
              initialMcpBundle,
              initialRegistration,
              resolved.identity,
              initialWorkspace,
            ),
          );
        } catch (error) {
          pendingSessions.delete(resolved.identity.sessionId);
          await activeHarnessContext.cleanup().catch((cleanupError: unknown) => notice(String(cleanupError)));
          throw error;
        }
        await bounded(harnessTelemetry.flush(), 'initial composition telemetry flush', notice);
      }

      const reservedOpens = new Map<string, Promise<DoomHubSessionScope>>();
      openSession = async (request, sessionId, pinnedArtifact, groupingWorkspaceId) => {
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
        // Membership follows the parent link, whatever the session is called or wherever its
        // checkout lives. Without a known parent, the checkout's own identity decides.
        const inheritedWorkspaceId =
          groupingWorkspaceId ??
          (request.parentSessionId
            ? (hub.session(request.parentSessionId)?.workspaceId ??
              openSessions.list().find((record) => record.sessionId === request.parentSessionId)?.workspaceId)
            : undefined);
        const parentArtifact =
          request.parentSessionId === undefined
            ? undefined
            : (sessionArtifacts.get(request.parentSessionId)?.registration ??
              pendingSessions.get(request.parentSessionId)?.registration ??
              openSessions.list().find((record) => record.sessionId === request.parentSessionId)?.artifact);
        const explicit = sessionSelectionArgs(request);
        const start = (async (): Promise<DoomHubSessionScope> => {
          // Snapshot only for creation. Explicit-ID resumes retain their own durable Fast state.
          const parent =
            request.parentSessionId !== undefined && (sessionId === undefined || request.reservationId !== undefined)
              ? sessionManager.get(request.parentSessionId)
              : undefined;
          let initialFastMode: boolean | undefined;
          if (parent !== undefined) {
            const state = await parent.runtime.readState();
            if (typeof state.fastMode !== 'boolean') throw new Error('Parent Fast mode must be a boolean.');
            initialFastMode = state.fastMode;
          }
          const childIdentity = resolveSessionIdentity([], identity);
          if (sessionId !== undefined && request.reservationId === undefined)
            childIdentity.agentArgs.push(
              '--session',
              path.join(serverDirectory, 'sessions', 'durable-v1', `${childIdentity.identity.sessionId}.sqlite`),
            );
          const childEnvironment = { ...baseEnvironment, ...request.environment };
          for (const key of [HARNESS_STATE_POINTER, ...Object.values(HARNESS_STATE_KEYS)]) delete childEnvironment[key];
          // The workspace is settled first: a member checkout reads its workspace's configuration.
          const workspace =
            inheritedWorkspaceId === undefined
              ? await admitWorkspace(request.cwd)
              : hub
                  .workspaces()
                  .find((candidate) => candidate.id === inheritedWorkspaceId && candidate.available !== false);
          if (workspace === undefined) throw new Error('The session workspace is unavailable.');
          const member = isMemberCheckout(request.cwd, workspace);
          const registration = await resolveSessionArtifact({
            member,
            pinned: pinnedArtifact,
            parent: parentArtifact,
            workspace: () => readSyncRegistration(workspace.root, homeDirectory),
            synchronize: async () => {
              const syncEnvironment: NodeJS.ProcessEnv = { ...baseEnvironment, DOOMPI_ROOT: workspace.root };
              for (const key of [HARNESS_STATE_POINTER, ...Object.values(HARNESS_STATE_KEYS)])
                delete syncEnvironment[key];
              await syncWorkspace(workspace.root, syncEnvironment);
            },
            prepareCurrent: async () => {
              const current = readSyncRegistration(workspace.root, homeDirectory);
              if (current === undefined)
                throw new Error(`Run the scoped DoomPi sync for '${workspace.root}' before opening it.`);
              return current;
            },
          });
          const childContext = await buildHarnessContext(
            resolveHarnessOptions({
              args: ['--cwd', request.cwd, ...childIdentity.agentArgs, ...explicit.args],
              cwd: request.cwd,
              environment: childEnvironment,
              ...(member ? { configRoot: workspace.root } : {}),
            }),
            harnessTelemetry,
          );
          try {
            if (childContext.options.hooks)
              await validateHookModules({
                repoRoot: childContext.options.repoRoot,
                homeDirectory,
                hookGroups: childContext.hookGroups,
                descriptor: readRegisteredSyncState(registration, homeDirectory).fileState.hookModules,
                isSubagent: Boolean(childEnvironment.PI_SUBAGENT_CHILD),
              });
            const bundle = await loadComposition(
              childContext.options.repoRoot,
              'session',
              {
                root: childContext.options.repoRoot,
                majorMode: childContext.options.majorMode,
                activeLayers: childContext.selectedLayers,
              },
              registration,
            );
            const mcpBundle = await loadSessionMcp(
              childContext.options.repoRoot,
              {
                majorMode: childContext.options.majorMode,
                activeLayers: childContext.selectedLayers,
              },
              registration,
            );
            request.signal?.throwIfAborted();
            pendingSessions.set(identity.sessionId, {
              cleanup: () => childContext.cleanup(),
              bundle,
              mcpBundle,
              registration,
            });
            const created = await hub.create(
              sessionHostOptions(childContext, bundle, mcpBundle, registration, identity, workspace, {
                pinned: explicit.pinned,
                ...(initialFastMode === undefined ? {} : { initialFastMode }),
                ...(request.selection?.minorModes === undefined ? {} : { minorModes: request.selection.minorModes }),
                ...(request.tools === undefined ? {} : { allowedTools: request.tools }),
              }),
            );
            request.signal?.throwIfAborted();
            if (created.workspaceId !== undefined) {
              const saved = openSessions.add({
                sessionId: created.id,
                workspaceId: created.workspaceId,
                cwd: created.cwd,
                repoRoot: childContext.options.repoRoot,
                groupingRoot: workspace.root,
                name: created.name,
                createdAt: created.createdAt,
                ...(created.parentSessionId === undefined ? {} : { parentSessionId: created.parentSessionId }),
                ...(created.sessionProvenance === undefined ? {} : { sessionProvenance: created.sessionProvenance }),
                ...(member ? { artifact: registration } : {}),
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
    const savedHistory = async (workspaceId: string) => {
      const root = hub
        .workspaces()
        .find((workspace) => workspace.id === workspaceId && workspace.available !== false)?.root;
      if (!root) throw new Error('Workspace not found.');
      return listSavedSessionRecords(
        path.join(serverDirectory, 'sessions'),
        root,
        new Set(hub.snapshot().map((active) => active.id)),
        workspaceId,
      );
    };
    const validatedExecution = (target: SavedSessionExecution, workspaceId: string): SyncRegistration | undefined => {
      const root = hub
        .workspaces()
        .find((workspace) => workspace.id === workspaceId && workspace.available !== false)?.root;
      if (!root || target.groupingRoot !== root || (target.workspaceId && target.workspaceId !== workspaceId))
        throw new Error('Saved session does not belong to this workspace.');
      if (fs.realpathSync(findRepositoryRoot(target.cwd)) !== target.repoRoot)
        throw new Error('Saved session checkout is unavailable.');
      // Only a member checkout records the workspace generation it ran.
      if (target.repoRoot === root) return undefined;
      if (target.inheritedArtifact === undefined) throw new Error('Saved member checkout generation is unavailable.');
      const artifact = parseSyncRegistration(target.inheritedArtifact, 'saved member checkout generation');
      validateSyncRegistration(artifact, resolveSyncLocation(artifact.root, homeDirectory));
      if (artifact.root !== root) throw new Error('Saved member checkout generation belongs to another workspace.');
      return artifact;
    };
    cockpit = await serveHeadlessServer({
      port: options.webPort,
      headlessHub: hub,
      token: attachToken,
      sessionMcpPublicOrigin: () => remoteRuntime?.remote.publicOrigin(),
      sessionMcpStateDir: serverDirectory,
      sessionMcpPublicOriginRevision: () => remoteRuntime?.remote.publicOriginRevision() ?? 0,
      isSessionPersisted: (sessionId, cwd) =>
        openSessions.list().some((record) => record.sessionId === sessionId && record.cwd === cwd),
      workspaceHistory: async (workspaceId) => (await savedHistory(workspaceId)).map((record) => record.summary),
      resumeWorkspaceSession: async (workspaceId, targetSessionId) => {
        const key = `${workspaceId}\0${targetSessionId}`;
        const pending = workspaceResumes.get(key);
        if (pending) return pending;
        const resume = (async () => {
          const target = (await savedHistory(workspaceId)).find((item) => item.summary.id === targetSessionId);
          if (!target)
            throw new Error('Saved Pi 1.0 session not found in this workspace. Earlier sessions cannot be resumed.');
          const artifact = validatedExecution(target.execution, workspaceId);
          await openSession(
            {
              cwd: target.execution.cwd,
              name: target.summary.name ?? 'untitled',
              ...(target.execution.parentSessionId ? { parentSessionId: target.execution.parentSessionId } : {}),
              ...(target.execution.sessionProvenance ? { sessionProvenance: target.execution.sessionProvenance } : {}),
            },
            target.summary.id,
            artifact,
            workspaceId,
          );
          return target.summary.id;
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
          session.workspaceId,
        );
      },
      readDormantTranscript: (record, request, context) => {
        const workspaceRoot = hub.workspaces().find((workspace) => workspace.id === record.workspaceId)?.root;
        if (!workspaceRoot || (record.groupingRoot !== undefined && record.groupingRoot !== workspaceRoot))
          throw new Error('Saved transcript unavailable.');
        const owner = fs.realpathSync(findRepositoryRoot(record.cwd));
        if (record.repoRoot !== undefined && record.repoRoot !== owner)
          throw new Error('Saved transcript checkout has changed.');
        return readSqliteTranscript(
          path.join(
            piAgentDirectory(baseEnvironment),
            'server',
            'sessions',
            'durable-v1',
            `${record.sessionId}.sqlite`,
          ),
          request,
          context,
          {
            sessionId: record.sessionId,
            workspaceRoot: owner,
            workspaceId: record.workspaceId,
            groupingRoot: workspaceRoot,
          },
        );
      },
      restartSession: async (session) => {
        const record = openSessions.list().find((entry) => entry.sessionId === session.id);
        // Only a member checkout records an artifact; it restarts on its workspace's generation.
        const member = record?.artifact !== undefined;
        const ownership = member
          ? resolveWorktreeRestart({
              session,
              record,
              artifact: sessionArtifacts.get(session.id)?.registration,
              workspaces: hub.workspaces(),
            })
          : undefined;
        if (!member) {
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
        }
        await hub.closeSession(session.id);
        try {
          await openSession(
            {
              cwd: session.cwd,
              name: session.name,
              ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
              ...(session.sessionProvenance === undefined ? {} : { sessionProvenance: session.sessionProvenance }),
            },
            session.id,
            ownership?.artifact,
            ownership?.workspaceId ?? session.workspaceId,
          );
        } catch (error) {
          // The journal lease allows one writer, so the new host cannot open before the old
          // one closes. Keep the closed session as dormant so it can be revived after a fix.
          if (record !== undefined) openSessions.add(record);
          throw error;
        }
      },
      resumeSession: async (session, targetSessionId) => {
        const workspaceId = session.workspaceId;
        if (!workspaceId || !hub.workspaces().some((workspace) => workspace.id === workspaceId))
          throw new Error('Session workspace not found.');
        const target = (await savedHistory(workspaceId)).find((item) => item.summary.id === targetSessionId);
        if (!target)
          throw new Error('Saved Pi 1.0 session not found in this workspace. Earlier sessions cannot be resumed.');
        const artifact = validatedExecution(target.execution, workspaceId);
        const closedRecord = openSessions.list().find((entry) => entry.sessionId === session.id);
        await hub.closeSession(session.id);
        try {
          await openSession(
            {
              cwd: target.execution.cwd,
              name: target.summary.name ?? 'untitled',
              ...(target.execution.parentSessionId ? { parentSessionId: target.execution.parentSessionId } : {}),
              ...(target.execution.sessionProvenance ? { sessionProvenance: target.execution.sessionProvenance } : {}),
            },
            target.summary.id,
            artifact,
            workspaceId,
          );
        } catch (error) {
          // Same as restart: the session given up for the resume stays revivable.
          if (closedRecord !== undefined) openSessions.add(closedRecord);
          throw error;
        }
        return target.summary.id;
      },
      dormantSessions: () => openSessions.list(),
      removeDormantSession: (record: OpenSessionRecord) => openSessions.remove(record.sessionId),
      reviveSession: async (record: OpenSessionRecord) => {
        // A failed wake may be transient, for example while another server still
        // owns the journal. Keep the record so the user can retry after resolving
        // the conflict instead of losing the session from the cockpit.
        const groupingRoot = hub
          .workspaces()
          .find((workspace) => workspace.id === record.workspaceId && workspace.available !== false)?.root;
        if (!groupingRoot || (record.groupingRoot !== undefined && groupingRoot !== record.groupingRoot))
          throw new Error('The session workspace is unavailable.');
        if (record.repoRoot !== undefined && fs.realpathSync(findRepositoryRoot(record.cwd)) !== record.repoRoot)
          throw new Error('The session checkout has changed.');
        if (record.artifact !== undefined && record.artifact.root !== groupingRoot)
          throw new Error('The inherited workspace generation is unavailable.');
        await openSession(
          {
            cwd: record.cwd,
            name: record.name,
            ...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
            ...(record.sessionProvenance === undefined ? {} : { sessionProvenance: record.sessionProvenance }),
          },
          record.sessionId,
          record.artifact,
          record.workspaceId,
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
    stopResourceMonitor();
    executionBudget.close();
    stopPersistSessionNames();
    clearInterval(eventLoopMonitor);
    await bounded(telemetry.recordEvent('doompi_server.shutdown'), 'shutdown telemetry', notice);
    await bounded(
      withShutdownDeadline(() => cockpit?.close(), 'listener shutdown'),
      'listener shutdown',
      notice,
    );
    await bounded(remoteRuntime?.close() ?? Promise.resolve(), 'remote control shutdown', notice);
    // Session hooks and MCP owners must unwind before their shared hub services.
    // Each session phase has its own deadline, so one stalled session cannot block the rest.
    try {
      await sessionManager.close();
    } catch (error) {
      notice(error instanceof Error ? error.message : String(error));
    }
    await bounded(
      withShutdownDeadline(() => hub.close(), 'hub shutdown'),
      'hub shutdown',
      notice,
    );
    await bounded(
      withShutdownDeadline(() => requestReceipts.close(), 'receipt shutdown'),
      'receipt shutdown',
      notice,
    );
    await bounded(
      withShutdownDeadline(() => computerUse?.close?.(), 'computer use shutdown'),
      'computer use shutdown',
      notice,
    );
    await bounded(
      withShutdownDeadline(() => webCompositions?.close(), 'web composition shutdown'),
      'web composition shutdown',
      notice,
    );
    const pendingCleanups = [...pendingSessions.values()].map((setup) =>
      bounded(
        withShutdownDeadline(() => setup.cleanup(), 'pending session cleanup'),
        'pending session cleanup',
        notice,
      ),
    );
    pendingSessions.clear();
    await Promise.allSettled(pendingCleanups);
    await bounded(harnessTelemetry.flush(), 'harness telemetry flush', notice);
    await bounded(harnessTelemetry.shutdown(), 'harness telemetry shutdown', notice);
    await bounded(telemetry.flush(), 'server telemetry flush', notice);
    await bounded(telemetry.shutdown(), 'server telemetry shutdown', notice);
  }
}
