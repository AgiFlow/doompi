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
import type { DoomApiContext } from '@agimon-ai/doompi-extension-contracts/package-api';
import type { HeadlessSessionHost, HeadlessSessionHostOptions } from '../../types/server/headlessSessionHost.ts';
import type { HeadlessSessionManager } from '../../types/server/headlessSessionManager.ts';

export interface HeadlessHubSession {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly parentSessionId?: string;
  readonly sessionProvenance?: string;
  /** Environment admitted for this session, when supplied by the host. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly host: HeadlessSessionHost;
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
  mountFacets(facets: readonly (DoomServerFacet | LoadedServerFacet)[]): Promise<void>;
  registerChannel(channel: DoomHubChannel): () => void;
  channelTypes(): readonly string[];
  channelFrames(sessionId: string): Array<{ type: string; sessionId: string; payload: unknown }>;
  receiveChannel(sessionId: string, frameType: string, payload: unknown, connectionId: string): void;
  disconnectChannels(connectionId: string): void;
  close(): Promise<void>;
}

interface StartedChannel {
  readonly channel: DoomHubChannel;
  readonly source: ReturnType<DoomHubChannel['start']>;
}

function scopeOf(session: HeadlessHubSession): DoomHubSessionScope {
  return {
    sessionId: session.id,
    cwd: session.cwd,
    ...(session.environment === undefined ? {} : { environment: session.environment }),
  };
}

/** Owns direct, same-process session and channel state for presentation adapters. */
export function createHeadlessHub(options: HeadlessHubOptions): HeadlessHub {
  const sessions = new Map<string, HeadlessHubSession>();
  const channels = new Map<string, StartedChannel>();
  const listeners = new Set<(event: HeadlessHubEvent) => void>();
  const subscriptions = new Set<() => void>();
  const sessionCleanups = new Map<string, () => void>();
  const directEventListeners = new Map<string, Set<(payload: unknown) => void>>();
  const directEventLatest = new Map<string, unknown>();
  const maxDirectEventLatest = 4096;
  let closed = false;
  let hubHost: DoomServerHost | undefined;
  let installedFacets: InstalledServerFacets | undefined;
  let sessionService: DoomHubSessionService;

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
  const channelHost = (frameType: string): DoomHubChannelHost => ({
    sessions: sessionScopes,
    sessionService,
    directEvents,
    publish: (sessionId, payload) => publish(frameType, sessionId, payload),
    publishToConnection: (connectionId, sessionId, payload) => {
      if (connectionId === '' || !sessions.has(sessionId)) return false;
      publish(frameType, sessionId, payload, connectionId);
      return true;
    },
    requestSessionApi: async (scope, request) => {
      if (!sessions.has(scope.sessionId)) return Response.json({ error: 'Session not found.' }, { status: 404 });
      if (options.requestSessionApi === undefined)
        return Response.json({ error: 'Session API unavailable.' }, { status: 404 });
      return options.requestSessionApi(scope, request);
    },
    onNotice: (message) => options.onNotice?.(message),
  });

  const startChannel = (channel: DoomHubChannel): StartedChannel | undefined => {
    if (channels.has(channel.frameType)) {
      options.onNotice?.(`hub channel '${channel.frameType}' is already registered`);
      return undefined;
    }
    try {
      const source = channel.start(channelHost(channel.frameType));
      const started = { channel, source };
      channels.set(channel.frameType, started);
      for (const session of sessions.values()) source.sessionAdded?.(scopeOf(session));
      return started;
    } catch (error) {
      options.onNotice?.(`hub channel '${channel.frameType}' failed (${String(error)})`);
      return undefined;
    }
  };

  const releaseChannel = (channel: DoomHubChannel, started: StartedChannel): void => {
    if (channels.get(channel.frameType) !== started) return;
    channels.delete(channel.frameType);
    started.source.close();
  };

  const unregisterSession = (sessionId: string): void => {
    const current = sessions.get(sessionId);
    if (current === undefined) return;
    const cleanup = sessionCleanups.get(sessionId);
    if (cleanup !== undefined) subscriptions.delete(cleanup);
    sessions.delete(sessionId);
    sessionCleanups.delete(sessionId);
    for (const { source } of channels.values()) source.sessionRemoved?.(sessionId);
    directEvents.clearSession?.(sessionId);
    emit({ kind: 'removed', sessionId });
  };

  const register = (session: HeadlessHubSession): void => {
    if (closed) throw new Error('The headless hub is closed.');
    if (sessions.has(session.id)) throw new Error(`Session '${session.id}' is already registered.`);
    sessions.set(session.id, session);
    for (const { source } of channels.values()) source.sessionAdded?.(scopeOf(session));
    const active = (): boolean => sessions.get(session.id) === session && !closed;
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
    emit({ kind: 'upsert', session });
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

  const mountFacets = async (facets: readonly (DoomServerFacet | LoadedServerFacet)[]): Promise<void> => {
    if (closed) throw new Error('The headless hub is closed.');
    if (hubHost !== undefined) throw new Error('The headless hub facets are already mounted.');
    const context: DoomApiContext = {
      scope: 'hub',
      ...(options.hubToken === undefined ? {} : { hubToken: options.hubToken }),
      sessionService,
      directEvents,
      onNotice: (message) => options.onNotice?.(message),
    };
    const host = createDoomServerHost({
      scope: 'hub',
      context,
      channelHostFor: (channel) => channelHost(channel.frameType),
      mountChannel: (channel) => {
        const started = startChannel(channel);
        if (started === undefined) return { mounted: false, dispose: () => undefined };
        return { mounted: true, dispose: () => releaseChannel(channel, started) };
      },
    });
    try {
      const installed = await installServerFacets({ host, facets, onNotice: options.onNotice });
      if (closed) {
        await installed.dispose();
        host.dispose();
        throw new Error('The headless hub was closed while mounting facets.');
      }
      hubHost = host;
      installedFacets = installed;
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
    async create(sessionOptions) {
      if (closed) throw new Error('The headless hub is closed.');
      const host = await options.manager.create(sessionOptions);
      const session: HeadlessHubSession = {
        id: sessionOptions.sessionId,
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
    registerChannel(channel) {
      const started = startChannel(channel);
      if (started === undefined) return () => undefined;
      return () => releaseChannel(channel, started);
    },
    channelTypes: () => [...channels.keys()],
    channelFrames(sessionId) {
      const session = sessions.get(sessionId);
      if (session === undefined) return [];
      const scope = scopeOf(session);
      const frames: Array<{ type: string; sessionId: string; payload: unknown }> = [];
      for (const [type, { source }] of channels) {
        const payload = source.payloadFor(scope);
        if (payload !== undefined) frames.push({ type, sessionId, payload });
      }
      return frames;
    },
    receiveChannel(sessionId, frameType, payload, connectionId) {
      if (connectionId === '') return;
      const session = sessions.get(sessionId);
      const started = channels.get(frameType);
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
      if (installedFacets !== undefined) {
        await installedFacets.dispose();
        installedFacets = undefined;
      }
      hubHost?.dispose();
      hubHost = undefined;
      for (const { source } of channels.values()) source.close();
      channels.clear();
      listeners.clear();
      sessions.clear();
      await Promise.all(ids.map((id) => options.manager.closeSession(id)));
    },
  };
}
