import type { DoomWebComposition } from '@agimon-ai/doompi-extension-contracts/package-api';
import type {
  DoomDirectEventBus,
  DoomHubChannel,
  DoomHubChannelConnection,
  DoomHubChannelHost,
  DoomHubSessionApiRequest,
  DoomHubSessionCreateRequest,
  DoomHubSessionScope,
  DoomHubSessionService,
} from '@agimon-ai/doompi-extension-contracts/hub-channel';
import {
  createDoomServerHost,
  installServerFacets,
  type DoomServerFacet,
  type DoomServerHost,
  type InstalledServerFacets,
  type LoadedServerFacet,
} from '@agimon-ai/doompi-extension-contracts/server-facet';
import type { DoomApiContext, DoomApiMount } from '@agimon-ai/doompi-extension-contracts/package-api';
import {
  createDoomPluginRegistry,
  type DoomPluginCaller,
  type DoomPluginDirection,
} from '@agimon-ai/doompi-extension-contracts/plugin-protocol';
import type { HeadlessSessionHost, HeadlessSessionHostOptions } from '../types/server/headlessSessionHost';
import type { HeadlessSessionManager } from '../types/server/headlessSessionManager';

export interface HeadlessHubSession {
  readonly id: string;
  readonly workspaceId?: string;
  webComposition?: DoomWebComposition;
  readonly name: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly parentSessionId?: string;
  readonly sessionProvenance?: string;
  readonly updatedAt?: string;
  readonly phase?: 'idle' | 'turn' | 'compaction' | 'retry';
  readonly phaseSince?: string;
  readonly pendingMessageCount?: number;
  readonly everPrompted?: boolean;
  readonly awaitingInput?: boolean;
  readonly lastSettledAt?: string;
  /** Environment admitted for this session, when supplied by the host. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly host: HeadlessSessionHost;
}

export interface HeadlessWorkspace {
  readonly id: string;
  readonly root: string;
}

export type HeadlessHubEvent =
  | { kind: 'upsert'; session: HeadlessHubSession }
  | { kind: 'removed'; sessionId: string }
  | { kind: 'channel'; frameType: string; sessionId: string; payload: unknown; connectionId?: string };

export interface HeadlessHubOptions {
  manager: HeadlessSessionManager;
  hubToken?: string;
  /** Creates a session through the canonical cockpit lifecycle for hub channels. */
  createSession?: (request: DoomHubSessionCreateRequest) => Promise<DoomHubSessionScope>;
  onNotice?: (message: string) => void;
  requestSessionApi?: (scope: DoomHubSessionScope, request: DoomHubSessionApiRequest) => Promise<Response>;
  admitWorkspace?: (root: string) => Promise<HeadlessWorkspace>;
  onWorkspaceRemoved?: (workspaceId: string) => void;
}

export interface HeadlessHub {
  /** Canonical direct lifecycle shared by hub channels, APIs, and sessions. */
  readonly sessionService: DoomHubSessionService;
  /** Lifecycle-owned event path shared by session facets and hub channels. */
  readonly directEvents: DoomDirectEventBus;
  snapshot(): readonly HeadlessHubSession[];
  session(sessionId: string): HeadlessHubSession | undefined;
  runtime(sessionId: string): HeadlessSessionHost['runtime'] | undefined;
  onEvent(listener: (event: HeadlessHubEvent) => void): () => void;
  register(session: HeadlessHubSession): void;
  create(options: HeadlessSessionHostOptions): Promise<HeadlessHubSession>;
  closeSession(sessionId: string): Promise<void>;
  /** Dispatches an authenticated package API request inside the owning process. */
  requestSessionApi(scope: DoomHubSessionScope, request: DoomHubSessionApiRequest): Promise<Response>;
  /** Mounts the selected hub facets once, before the headless server accepts clients. */
  mountFacets(facets: readonly (DoomServerFacet | LoadedServerFacet)[], context?: DoomApiContext): Promise<void>;
  workspaces(): readonly HeadlessWorkspace[];
  admitWorkspace(root: string): Promise<HeadlessWorkspace>;
  removeWorkspace(workspaceId: string): Promise<void>;
  requestApi(mount: DoomApiMount, basePath: string, request: Request): Promise<Response>;
  invokePlugin(call: unknown, direction: DoomPluginDirection, caller?: DoomPluginCaller): Promise<unknown>;
  registerChannel(channel: DoomHubChannel, mount?: DoomApiMount): () => void;
  channelTypes(): readonly string[];
  channelFrames(sessionId: string): Array<{ type: string; sessionId: string; payload: unknown }>;
  /** Resolves a channel-owned child journal for the browser thread projection. */
  threadJournal(sessionId: string, threadId: string): string | undefined;
  receiveChannel(sessionId: string, frameType: string, payload: unknown, connectionId: string): void;
  disconnectChannels(connectionId: string): void;
  close(): Promise<void>;
}

interface StartedChannel {
  readonly channel: DoomHubChannel;
  readonly source: ReturnType<DoomHubChannel['start']>;
  readonly mount: DoomApiMount;
}

function scopeOf(session: HeadlessHubSession): DoomHubSessionScope {
  return {
    sessionId: session.id,
    ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
    cwd: session.cwd,
    ...(session.environment === undefined ? {} : { environment: session.environment }),
  };
}

/** Owns direct, same-process session and channel state for presentation adapters. */
export function createHeadlessHub(options: HeadlessHubOptions): HeadlessHub {
  const sessions = new Map<string, HeadlessHubSession>();
  const pluginRegistry = createDoomPluginRegistry();
  const channels = new Map<string, StartedChannel>();
  const listeners = new Set<(event: HeadlessHubEvent) => void>();
  const subscriptions = new Set<() => void>();
  const sessionCleanups = new Map<string, () => void>();
  const presentationCleanups = new Map<string, () => void>();
  const directEventListeners = new Map<string, Set<(payload: unknown) => void>>();
  const directEventLatest = new Map<string, unknown>();
  const maxDirectEventLatest = 4096;
  let closed = false;
  const mounts = new Map<string, { host: DoomServerHost; installed: InstalledServerFacets }>();
  const workspaces = new Map<string, HeadlessWorkspace>();
  let sessionService: DoomHubSessionService;

  const mountKey = (mount: DoomApiMount): string =>
    mount.scope === 'global'
      ? 'global'
      : mount.scope === 'workspace'
        ? `workspace:${mount.workspaceId}`
        : `session:${mount.sessionId}`;
  const belongs = (mount: DoomApiMount, session: HeadlessHubSession): boolean =>
    mount.scope === 'global' ||
    (mount.scope === 'workspace' ? session.workspaceId === mount.workspaceId : session.id === mount.sessionId);
  const selectedChannels = (session: HeadlessHubSession): StartedChannel[] => {
    const selected = new Map<string, StartedChannel>();
    const priority = { global: 0, workspace: 1, session: 2 };
    for (const started of channels.values()) {
      if (!belongs(started.mount, session)) continue;
      const previous = selected.get(started.channel.frameType);
      if (!previous || priority[started.mount.scope] > priority[previous.mount.scope])
        selected.set(started.channel.frameType, started);
    }
    return [...selected.values()];
  };

  const directEventKey = (frameType: string, sessionId: string): string => `${frameType}\0${sessionId}`;
  const directEvents: DoomDirectEventBus = {
    publish(frameType, sessionId, payload) {
      if (closed) return;
      const key = directEventKey(frameType, sessionId);
      directEventLatest.set(key, payload);
      while (directEventLatest.size > maxDirectEventLatest) {
        const oldest = directEventLatest.keys().next().value;
        if (oldest === undefined) break;
        directEventLatest.delete(oldest);
      }
      const listeners = directEventListeners.get(key);
      if (listeners === undefined) return;
      for (const listener of listeners) listener(payload);
    },
    subscribe(frameType, sessionId, listener, options) {
      if (closed) return () => undefined;
      const key = directEventKey(frameType, sessionId);
      const listeners = directEventListeners.get(key) ?? new Set<(payload: unknown) => void>();
      listeners.add(listener);
      directEventListeners.set(key, listeners);
      if (options?.replayLatest && directEventLatest.has(key)) listener(directEventLatest.get(key));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        listeners.delete(listener);
        if (listeners.size === 0) directEventListeners.delete(key);
      };
    },
    clearSession(sessionId) {
      const suffix = `\0${sessionId}`;
      for (const key of directEventLatest.keys()) if (key.endsWith(suffix)) directEventLatest.delete(key);
    },
    close() {
      directEventListeners.clear();
      directEventLatest.clear();
    },
  };

  const emit = (event: HeadlessHubEvent): void => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };
  const sessionScopes = (): readonly DoomHubSessionScope[] => [...sessions.values()].map(scopeOf);
  const publish = (frameType: string, sessionId: string, payload: unknown, connectionId?: string): void => {
    if (!sessions.has(sessionId)) return;
    emit({ kind: 'channel', frameType, sessionId, payload, ...(connectionId === undefined ? {} : { connectionId }) });
  };
  const channelHost = (frameType: string, mount: DoomApiMount): DoomHubChannelHost => ({
    sessions: () =>
      sessionScopes().filter((scope) => {
        const session = sessions.get(scope.sessionId);
        return session !== undefined && belongs(mount, session);
      }),
    sessionService: {
      create: async (request) => {
        if (mount.scope !== 'global') {
          const parent = request.parentSessionId === undefined ? undefined : sessions.get(request.parentSessionId);
          if (!parent || !belongs(mount, parent)) throw new Error('Parent session is outside this mount.');
        }
        return sessionService.create(request);
      },
      close: async (id) => {
        const session = sessions.get(id);
        if (!session || !belongs(mount, session)) throw new Error('Session is outside this mount.');
        await sessionService.close(id);
      },
      isLive: (id) => {
        const session = sessions.get(id);
        return session !== undefined && belongs(mount, session);
      },
    },
    directEvents: {
      publish: (type, id, payload) => {
        const session = sessions.get(id);
        if (session && belongs(mount, session)) directEvents.publish(type, id, payload);
      },
      subscribe: (type, id, listener, subscriptionOptions) => {
        const session = sessions.get(id);
        return session && belongs(mount, session)
          ? directEvents.subscribe(type, id, listener, subscriptionOptions)
          : () => undefined;
      },
      close: () => undefined,
    },
    publish: (sessionId, payload) => {
      const session = sessions.get(sessionId);
      if (
        session &&
        selectedChannels(session).some(
          (started) => started.channel.frameType === frameType && mountKey(started.mount) === mountKey(mount),
        )
      )
        publish(frameType, sessionId, payload);
    },
    publishToConnection: (connectionId, sessionId, payload) => {
      const session = sessions.get(sessionId);
      if (
        connectionId === '' ||
        !session ||
        !selectedChannels(session).some(
          (started) => started.channel.frameType === frameType && mountKey(started.mount) === mountKey(mount),
        )
      )
        return false;
      publish(frameType, sessionId, payload, connectionId);
      return true;
    },
    requestSessionApi: async (scope, request) => {
      const session = sessions.get(scope.sessionId);
      if (!session || !belongs(mount, session)) return Response.json({ error: 'Session not found.' }, { status: 404 });
      if (options.requestSessionApi === undefined)
        return Response.json({ error: 'Session API unavailable.' }, { status: 404 });
      return options.requestSessionApi(scope, request);
    },
    onNotice: (message) => options.onNotice?.(message),
  });

  const startChannel = (channel: DoomHubChannel, mount: DoomApiMount): StartedChannel | undefined => {
    const key = `${mountKey(mount)}:${channel.frameType}`;
    if (channels.has(key)) {
      options.onNotice?.(`hub channel '${channel.frameType}' is already registered`);
      return undefined;
    }
    try {
      const source = channel.start(channelHost(channel.frameType, mount));
      const started = { channel, source, mount };
      channels.set(key, started);
      for (const session of sessions.values()) if (belongs(mount, session)) source.sessionAdded?.(scopeOf(session));
      return started;
    } catch (error) {
      options.onNotice?.(`hub channel '${channel.frameType}' failed (${String(error)})`);
      return undefined;
    }
  };

  const releaseChannel = (channel: DoomHubChannel, started: StartedChannel): void => {
    const key = `${mountKey(started.mount)}:${channel.frameType}`;
    if (channels.get(key) !== started) return;
    channels.delete(key);
    started.source.close();
  };

  const receiveMountedChannel = (
    mount: DoomApiMount,
    sessionId: string,
    frameType: string,
    payload: unknown,
    connectionId: string,
  ): boolean => {
    if (!connectionId) return false;
    const session = sessions.get(sessionId);
    if (!session || !belongs(mount, session)) return false;
    const started = channels.get(`${mountKey(mount)}:${frameType}`);
    if (!started?.channel.receive) return false;
    started.channel.receive(scopeOf(session), payload, { connectionId });
    return true;
  };

  const unregisterSession = (sessionId: string): void => {
    const current = sessions.get(sessionId);
    if (current === undefined) return;
    const cleanup = sessionCleanups.get(sessionId);
    if (cleanup !== undefined) subscriptions.delete(cleanup);
    sessions.delete(sessionId);
    sessionCleanups.delete(sessionId);
    presentationCleanups.get(sessionId)?.();
    presentationCleanups.delete(sessionId);
    for (const { source, mount } of channels.values()) if (belongs(mount, current)) source.sessionRemoved?.(sessionId);
    directEvents.clearSession?.(sessionId);
    emit({ kind: 'removed', sessionId });
  };

  const register = (session: HeadlessHubSession): void => {
    if (closed) throw new Error('The headless hub is closed.');
    if (sessions.has(session.id)) throw new Error(`Session '${session.id}' is already registered.`);
    let current: HeadlessHubSession = {
      ...session,
      updatedAt: session.updatedAt ?? session.createdAt,
      phase: session.phase ?? 'idle',
      phaseSince: session.phaseSince ?? session.createdAt,
      pendingMessageCount: session.pendingMessageCount ?? 0,
      everPrompted: session.everPrompted ?? false,
      awaitingInput: session.awaitingInput ?? false,
    };
    sessions.set(session.id, current);
    const stopPresentation = session.host.onPresentationFrame((frame) => {
      if (sessions.get(session.id)?.host !== session.host) return;
      const type = typeof frame.type === 'string' ? frame.type : '';
      // Streaming updates belong to the session presentation. Replicating the
      // hub's growing event list for every token makes model output quadratic.
      if (
        type !== 'agent_start' &&
        type !== 'agent_settled' &&
        type !== 'message_end' &&
        type !== 'extension_ui_request' &&
        type !== 'extension_ui_answered'
      )
        return;
      const now = new Date().toISOString();
      const phase = type === 'agent_start' ? 'turn' : type === 'agent_settled' ? 'idle' : current.phase;
      const phaseChanged = phase !== current.phase;
      const method = typeof frame.method === 'string' ? frame.method : '';
      const awaitingInput =
        type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(method)
          ? true
          : type === 'extension_ui_answered' || type === 'agent_settled'
            ? false
            : current.awaitingInput;
      current = {
        ...current,
        updatedAt: now,
        phase,
        phaseSince: phaseChanged ? now : current.phaseSince,
        everPrompted: current.everPrompted || type === 'agent_start',
        awaitingInput,
        ...(type === 'agent_settled' ? { lastSettledAt: now } : {}),
      };
      sessions.set(session.id, current);
      emit({ kind: 'upsert', session: current });
    });
    presentationCleanups.set(session.id, stopPresentation);
    for (const { source, mount } of channels.values())
      if (belongs(mount, session)) source.sessionAdded?.(scopeOf(session));
    const active = (): boolean => sessions.get(session.id)?.host === session.host && !closed;
    const cleanup = (): void => {
      subscriptions.delete(cleanup);
      sessionCleanups.delete(session.id);
      if (!active()) return;
      unregisterSession(session.id);
      void options.manager
        .closeSession(session.id)
        .catch((error: unknown) =>
          options.onNotice?.(
            `session ${session.id} cleanup failed (${error instanceof Error ? error.message : String(error)})`,
          ),
        );
    };
    sessionCleanups.set(session.id, cleanup);
    void session.host.runtime.exited.then(cleanup, cleanup);
    subscriptions.add(cleanup);
    emit({ kind: 'upsert', session: current });
  };

  const closeSession = async (sessionId: string): Promise<void> => {
    const session = sessions.get(sessionId);
    if (session === undefined) return;
    unregisterSession(sessionId);
    await options.manager.closeSession(sessionId);
  };

  sessionService = {
    create: async (request) => {
      if (options.createSession === undefined)
        throw new Error('The cockpit session service cannot create sessions in this host.');
      return options.createSession(request);
    },
    close: closeSession,
    isLive: (sessionId) => !closed && sessions.has(sessionId),
  };

  const mountFacets = async (
    facets: readonly (DoomServerFacet | LoadedServerFacet)[],
    suppliedContext?: DoomApiContext,
  ): Promise<void> => {
    if (closed) throw new Error('The headless hub is closed.');
    const context: DoomApiContext = suppliedContext ?? {
      scope: 'global',
      ...(options.hubToken === undefined ? {} : { hubToken: options.hubToken }),
      sessionService,
      directEvents,
      onNotice: (message) => options.onNotice?.(message),
    };
    if (context.scope === 'session') throw new Error('Session facets belong to their session host.');
    if (context.scope === 'workspace' && (!context.workspaceId || !context.workspaceRoot))
      throw new Error('Workspace mounts require an admitted identity and root.');
    const mount: DoomApiMount =
      context.scope === 'global' ? { scope: 'global' } : { scope: 'workspace', workspaceId: context.workspaceId! };
    const key = mountKey(mount);
    if (mounts.has(key)) throw new Error(`The '${key}' facets are already mounted.`);
    const host = createDoomServerHost({
      scope: context.scope,
      context: {
        ...context,
        sessionService: channelHost('', mount).sessionService,
        directEvents: channelHost('', mount).directEvents,
        receiveChannel: (sessionId, frameType, payload, connectionId) =>
          receiveMountedChannel(mount, sessionId, frameType, payload, connectionId),
      },
      mountChannel: (channel) => {
        const started = startChannel(channel, mount);
        if (started === undefined) return { mounted: false, dispose: () => undefined };
        return { mounted: true, dispose: () => releaseChannel(channel, started) };
      },
      pluginRegistry,
    });
    try {
      const installed = await installServerFacets({ host, facets, onNotice: options.onNotice });
      if (closed) {
        await installed.dispose();
        throw new Error('The headless hub was closed while mounting facets.');
      }
      mounts.set(key, { host, installed });
      if (mount.scope === 'workspace')
        workspaces.set(mount.workspaceId, { id: mount.workspaceId, root: context.workspaceRoot! });
    } catch (error) {
      host.dispose();
      throw error;
    }
  };

  return {
    sessionService,
    directEvents,
    snapshot: () => [...sessions.values()],
    session: (sessionId) => sessions.get(sessionId),
    runtime: (sessionId) => sessions.get(sessionId)?.host.runtime,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register,
    mountFacets,
    workspaces: () => [...workspaces.values()],
    admitWorkspace: async (root) => {
      if (!options.admitWorkspace) throw new Error('Workspace admission is unavailable.');
      return options.admitWorkspace(root);
    },
    async removeWorkspace(id) {
      if ([...sessions.values()].some((session) => session.workspaceId === id))
        throw new Error('Workspace still has live sessions.');
      const key = mountKey({ scope: 'workspace', workspaceId: id });
      const mounted = mounts.get(key);
      if (!mounted) return;
      mounts.delete(key);
      workspaces.delete(id);
      options.onWorkspaceRemoved?.(id);
      try {
        await mounted.installed.dispose();
      } finally {
        mounted.host.dispose();
      }
    },
    async requestApi(mount, basePath, request) {
      if (closed) return Response.json({ error: 'Server is closed.' }, { status: 503 });
      if (mount.scope === 'session') {
        const session = sessions.get(mount.sessionId);
        if (!session || !options.requestSessionApi)
          return Response.json({ error: 'Session not found.' }, { status: 404 });
        const url = new URL(request.url);
        return options.requestSessionApi(scopeOf(session), {
          basePath,
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers: request.headers,
          signal: request.signal,
          body: request.body === null ? undefined : new Uint8Array(await request.arrayBuffer()),
        });
      }
      const handler = mounts.get(mountKey(mount))?.host.handlerFor(basePath);
      if (!handler)
        return Response.json({ error: `API '${basePath}' is not mounted in ${mountKey(mount)}.` }, { status: 404 });
      return handler.fetch(request);
    },
    invokePlugin: (call, direction, caller) => pluginRegistry.invoke(call, direction, caller),
    async create(sessionOptions) {
      if (closed) throw new Error('The headless hub is closed.');
      const host = await options.manager.create(sessionOptions);
      const session: HeadlessHubSession = {
        id: sessionOptions.sessionId,
        workspaceId: sessionOptions.workspaceId,
        webComposition: sessionOptions.webComposition,
        name: sessionOptions.sessionName,
        cwd: sessionOptions.cwd,
        createdAt: new Date().toISOString(),
        ...(sessionOptions.parentSessionId === undefined ? {} : { parentSessionId: sessionOptions.parentSessionId }),
        ...(sessionOptions.sessionProvenance === undefined
          ? {}
          : { sessionProvenance: sessionOptions.sessionProvenance }),
        environment: sessionOptions.environment,
        host,
      };
      register(session);
      return session;
    },
    closeSession,
    async requestSessionApi(scope, request) {
      if (closed || !sessions.has(scope.sessionId))
        return Response.json({ error: 'Session not found.' }, { status: 404 });
      if (options.requestSessionApi === undefined)
        return Response.json({ error: 'Session API unavailable.' }, { status: 404 });
      return options.requestSessionApi(scope, request);
    },
    registerChannel(channel, mount = { scope: 'global' }) {
      const started = startChannel(channel, mount);
      if (started === undefined) return () => undefined;
      return () => releaseChannel(channel, started);
    },
    channelTypes: () => [...new Set([...channels.values()].map(({ channel }) => channel.frameType))],
    channelFrames(sessionId) {
      const session = sessions.get(sessionId);
      if (session === undefined) return [];
      const scope = scopeOf(session);
      const frames: Array<{ type: string; sessionId: string; payload: unknown }> = [];
      for (const { channel, source } of selectedChannels(session)) {
        const type = channel.frameType;
        const payload = source.payloadFor(scope);
        if (payload !== undefined) frames.push({ type, sessionId, payload });
      }
      return frames;
    },
    threadJournal(sessionId, threadId) {
      const session = sessions.get(sessionId);
      if (session === undefined) return undefined;
      const scope = scopeOf(session);
      for (const { source } of selectedChannels(session)) {
        const journal = source.threadJournal?.(scope, threadId);
        if (journal !== undefined) return journal;
      }
      return undefined;
    },
    receiveChannel(sessionId, frameType, payload, connectionId) {
      if (connectionId === '') return;
      const session = sessions.get(sessionId);
      const started = session && selectedChannels(session).find(({ channel }) => channel.frameType === frameType);
      if (session === undefined || started === undefined) return;
      started.channel.receive?.(scopeOf(session), payload, { connectionId } satisfies DoomHubChannelConnection);
    },
    disconnectChannels(connectionId) {
      if (connectionId === '') return;
      for (const { channel } of channels.values()) channel.disconnected?.({ connectionId });
    },
    async close() {
      if (closed) return;
      const ids = [...sessions.keys()];
      closed = true;
      directEvents.close();
      for (const unsubscribe of subscriptions) unsubscribe();
      subscriptions.clear();
      for (const cleanup of presentationCleanups.values()) cleanup();
      presentationCleanups.clear();
      const failures: unknown[] = [];
      for (const mounted of [...mounts.values()].reverse()) {
        try {
          await mounted.installed.dispose();
        } catch (error) {
          failures.push(error);
        }
        try {
          mounted.host.dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      mounts.clear();
      pluginRegistry.dispose();
      workspaces.clear();
      for (const { source } of channels.values()) source.close();
      channels.clear();
      listeners.clear();
      sessions.clear();
      const outcomes = await Promise.allSettled(ids.map((id) => options.manager.closeSession(id)));
      for (const outcome of outcomes) if (outcome.status === 'rejected') failures.push(outcome.reason);
      if (failures.length) throw new AggregateError(failures, 'Mount shutdown failed');
    },
  };
}
