import crypto from 'node:crypto';

import type {
  DoomComputerUseHostBinding,
  DoomDirectEventBus,
  DoomHubChannel,
  DoomHubChannelConnection,
  DoomHubChannelHost,
  DoomHubReservedWorktreeProvisioner,
  DoomHubSessionApiRequest,
  DoomHubSessionCreateRequest,
  DoomHubSessionScope,
  DoomHubSessionService,
  DoomSessionCommunicationEndpoint,
  DoomHubSessionReservations,
  DoomPendingSessionSetup,
  DoomSessionActivity,
} from '../exports/hubChannel';
import type { DoomWebComposition } from '../exports/packageApi';
import type { DoomApiContext, DoomApiMount } from '../exports/packageApi';
import {
  createDoomPluginRegistry,
  type DoomPluginCaller,
  type DoomPluginDirection,
  type DoomPluginRegistry,
} from '../exports/pluginProtocol';
import {
  createDoomServerHost,
  installServerFacets,
  type DoomServerFacet,
  type DoomServerHost,
  type InstalledServerFacets,
  type LoadedServerFacet,
} from '../exports/serverFacet';
import { DOOM_NOTIFICATION_ENTRY_TYPE } from '../schemas/notification';
import { PROFILE_ICON_MIME_TYPES } from '../schemas/profileIdentity';
import { readSessionGitStatus } from '../services/sessionGitStatus';
import type { SessionGitStatus } from '../services/sessionGitStatus/type';
import type { HeadlessSessionHost, HeadlessSessionHostOptions } from '../systems/main/types/headlessSessionHost';
import type { HeadlessSessionCloseOptions, HeadlessSessionManager } from '../systems/main/types/headlessSessionManager';
import { AGENT_SETTLED_ENTRY_TYPE } from './directHarnessRuntime';

const AUTHORIZATION_HEADER = 'authorization';
const CHANNEL_PRIORITY = { global: 0, workspace: 1, session: 2 } as const;
const ICON_VERSION_LENGTH = 12;
const ICON_DATA_URL = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=]+)$/u;
/** A rail line, not a log: a longer label is cut to this. */
const MAX_ACTIVITY_LABEL = 80;

/** The profile a session runs under, as shown on its rail card. The icon itself is served separately. */
export interface HeadlessSessionProfile {
  readonly name: string;
  readonly displayName?: string;
  /** Changes whenever the icon does, so a client can cache the avatar by it. */
  readonly iconVersion?: string;
}

/** A profile's persona presentation: display name and icon as a data: URL. */
export interface HeadlessProfileIdentity {
  readonly displayName?: string;
  readonly icon?: string;
}

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
  /** Branch and dirty flag of the session cwd; absent outside a git work tree. */
  readonly git?: SessionGitStatus;
  /** Selected profile; absent when the session runs without one. */
  readonly profile?: HeadlessSessionProfile;
  readonly pendingSetups?: readonly DoomPendingSessionSetup[];
  /** The line the session's extension last published about work it runs; absent when none. */
  readonly activity?: DoomSessionActivity;
  /** Environment admitted for this session, when supplied by the host. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly host: HeadlessSessionHost;
}

export interface HeadlessWorkspace {
  readonly id: string;
  readonly root: string;
  readonly name?: string;
  readonly available?: boolean;
}

/** A workspace to admit: an existing folder, or a name alone for a new default folder. */
export interface HeadlessWorkspaceAdmission {
  readonly root?: string;
  readonly name?: string;
}

export type HeadlessHubEvent =
  | { kind: 'upsert'; session: HeadlessHubSession }
  /** `dormant`: the session stopped running but keeps its record, so it lists as dormant. */
  | { kind: 'removed'; sessionId: string; dormant?: true }
  | { kind: 'workspace_upsert'; workspace: HeadlessWorkspace }
  | { kind: 'workspace_removed'; workspaceId: string }
  | { kind: 'channel'; frameType: string; sessionId: string; payload: unknown; connectionId?: string }
  /** A live session frame every hub client needs: notification entries and agent dialogs. */
  | { kind: 'frame'; sessionId: string; frame: Record<string, unknown> };

export interface HeadlessHubOptions {
  manager: HeadlessSessionManager;
  /** Resolves the hub credential, because the server reads its token file after the hub exists. */
  hubToken?: () => string | undefined;
  /** Creates a session through the canonical cockpit lifecycle for hub channels. */
  createSession?: (
    request: DoomHubSessionCreateRequest,
    /**
     * Set when a workspace-mounted package creates a session with no parent. The host must
     * refuse a cwd outside that workspace before admitting anything.
     */
    placement?: { workspaceId: string },
  ) => Promise<DoomHubSessionScope>;
  onNotice?: (message: string) => void;
  sessionReservations?: DoomHubSessionReservations;
  requestSessionApi?: (scope: DoomHubSessionScope, request: DoomHubSessionApiRequest) => Promise<Response>;
  computerUse?: DoomComputerUseHostBinding;
  admitWorkspace?: (request: HeadlessWorkspaceAdmission) => Promise<HeadlessWorkspace>;
  onWorkspaceRemoved?: (workspaceId: string) => void;
  /** Reads a session cwd's git status; defaults to the git CLI. */
  readGitStatus?: (cwd: string) => Promise<SessionGitStatus | undefined>;
  /** Resolves a profile's persona presentation for a workspace root; sessions show no avatar without it. */
  resolveProfileIdentity?: (root: string, profile: string) => HeadlessProfileIdentity | undefined;
}

export interface HeadlessHub {
  /** Canonical direct lifecycle shared by hub channels, APIs, and sessions. */
  readonly sessionService: DoomHubSessionService;
  /** Lifecycle-owned event path shared by session facets and hub channels. */
  readonly directEvents: DoomDirectEventBus;
  readonly computerUse?: DoomComputerUseHostBinding;
  snapshot(): readonly HeadlessHubSession[];
  session(sessionId: string): HeadlessHubSession | undefined;
  runtime(sessionId: string): HeadlessSessionHost['runtime'] | undefined;
  /** The session's profile avatar image, when its profile has an icon. */
  sessionAvatar(sessionId: string): { mimeType: string; bytes: Uint8Array } | undefined;
  onEvent(listener: (event: HeadlessHubEvent) => void): () => void;
  register(session: HeadlessHubSession): void;
  create(options: HeadlessSessionHostOptions): Promise<HeadlessHubSession>;
  closeSession(sessionId: string, options?: HeadlessSessionCloseOptions): Promise<void>;
  /** Publishes removal of a persisted session that has no live host. */
  notifySessionRemoved(sessionId: string): void;
  /** Publishes setup-only children through the parent's normal session updates. */
  setPendingSessionSetups?(sessionId: string, pending: readonly DoomPendingSessionSetup[]): void;
  /** Replaces the session's activity line; undefined clears it. Unknown sessions are ignored. */
  setSessionActivity?(sessionId: string, activity: DoomSessionActivity | undefined): void;
  /** Dispatches an authenticated package API request inside the owning process. */
  requestSessionApi(scope: DoomHubSessionScope, request: DoomHubSessionApiRequest): Promise<Response>;
  /** Mounts the selected hub facets once, before the headless server accepts clients. */
  mountFacets(facets: readonly (DoomServerFacet | LoadedServerFacet)[], context?: DoomApiContext): Promise<void>;
  workspaces(): readonly HeadlessWorkspace[];
  registerWorkspace(workspace: HeadlessWorkspace): void;
  admitWorkspace(request: HeadlessWorkspaceAdmission): Promise<HeadlessWorkspace>;
  removeWorkspace(workspaceId: string): Promise<void>;
  requestApi(mount: DoomApiMount, basePath: string, request: Request): Promise<Response>;
  /** The dispatch table hub facets mount into, shared with session hosts this hub serves. */
  readonly pluginRegistry: DoomPluginRegistry;
  invokePlugin(call: unknown, direction: DoomPluginDirection, caller?: DoomPluginCaller): Promise<unknown>;
  registerChannel(channel: DoomHubChannel, mount?: DoomApiMount): () => void;
  channelTypes(): readonly string[];
  channelFrames(sessionId: string): Array<{ type: string; sessionId: string; payload: unknown }>;
  /** Resolves a channel-owned child journal for the browser thread projection. */
  threadJournal(sessionId: string, threadId: string): string | undefined;
  receiveChannel(
    sessionId: string,
    frameType: string,
    payload: unknown,
    connectionId: string,
    desktopAuthorized?: boolean,
    computerUseAuthorized?: boolean,
  ): void;
  disconnectChannels(connectionId: string): void;
  close(): Promise<void>;
}

interface StartedChannel {
  readonly channel: DoomHubChannel;
  readonly source: ReturnType<DoomHubChannel['start']>;
  readonly mount: DoomApiMount;
}

/**
 * When a reopened session last settled, from the marker its runtime journals at every run end.
 * Without it a session with a whole history would read as fresh until its next turn.
 */
async function lastSettledAt(host: HeadlessSessionHost): Promise<string | undefined> {
  try {
    const entry = (await host.runtime.readEntries()).entries.findLast(
      (entry) => entry.type === 'custom' && entry.customType === AGENT_SETTLED_ENTRY_TYPE,
    );
    const data = entry?.type === 'custom' ? (entry.data as { timestamp?: unknown } | undefined) : undefined;
    return typeof data?.timestamp === 'number' && Number.isFinite(data.timestamp)
      ? new Date(data.timestamp).toISOString()
      : undefined;
  } catch {
    // A runtime without a readable journal has no history to report; the rail shows it as fresh.
    return undefined;
  }
}

function scopeOf(session: HeadlessHubSession): DoomHubSessionScope {
  return {
    sessionId: session.id,
    ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
    cwd: session.cwd,
    ...(session.environment === undefined ? {} : { environment: session.environment }),
    ...(session.host.sessionContext === undefined ? {} : { sessionContext: session.host.sessionContext }),
  };
}

/** Owns direct, same-process session and channel state for presentation adapters. */
export function createHeadlessHub(options: HeadlessHubOptions): HeadlessHub {
  const sessions = new Map<string, HeadlessHubSession>();
  const pendingSetups = new Map<string, readonly DoomPendingSessionSetup[]>();
  const activities = new Map<string, DoomSessionActivity>();
  const present = (session: HeadlessHubSession): HeadlessHubSession => {
    const pending = pendingSetups.get(session.id);
    const activity = activities.get(session.id);
    if (pending === undefined && activity === undefined) return session;
    return {
      ...session,
      ...(pending === undefined ? {} : { pendingSetups: pending }),
      ...(activity === undefined ? {} : { activity }),
    };
  };
  const pluginRegistry = createDoomPluginRegistry();
  const channels = new Map<string, StartedChannel>();
  const listeners = new Set<(event: HeadlessHubEvent) => void>();
  const subscriptions = new Set<() => void>();
  const sessionCleanups = new Map<string, () => void>();
  const presentationCleanups = new Map<string, () => void>();
  /** Profile icons by session, kept out of summaries because each can be hundreds of kilobytes. */
  const avatarIcons = new Map<string, string>();
  const sessionShutdowns = new Map<string, { session: HeadlessHubSession; promise: Promise<void>; pending: boolean }>();
  const directEventListeners = new Map<string, Set<(payload: unknown) => void>>();
  const directEventLatest = new Map<string, unknown>();
  const maxDirectEventLatest = 4096;
  const communicationEndpoints = new Map<
    string,
    {
      listeners: Map<string, Set<(sourceSessionId: string, payload: unknown) => void>>;
      readyListeners: Set<(peerSessionId: string) => void>;
      ready: boolean;
      endpoint: DoomSessionCommunicationEndpoint;
    }
  >();
  let closed = false;
  const mounts = new Map<string, { host: DoomServerHost; installed: InstalledServerFacets }>();
  const workspaces = new Map<string, HeadlessWorkspace>();
  const worktreeProvisioners = new Map<
    string,
    { mount: DoomApiMount; provisioner: DoomHubReservedWorktreeProvisioner }
  >();
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
  const canClose = (mount: DoomApiMount, session: HeadlessHubSession): boolean =>
    belongs(mount, session) || (mount.scope === 'session' && session.parentSessionId === mount.sessionId);
  const canCommunicate = (sourceId: string, targetId: string): boolean => {
    if (closed || sourceId === targetId) return false;
    const source = sessions.get(sourceId);
    const target = sessions.get(targetId);
    return (
      source !== undefined &&
      target !== undefined &&
      (source.parentSessionId === target.id || target.parentSessionId === source.id)
    );
  };
  const registerReservedWorktreeProvisioner = (
    mount: DoomApiMount,
    provisioner: DoomHubReservedWorktreeProvisioner,
  ): (() => void) => {
    const key = mountKey(mount);
    if (worktreeProvisioners.has(key)) throw new Error('A worktree provisioner is already registered.');
    worktreeProvisioners.set(key, { mount, provisioner });
    return () => {
      if (worktreeProvisioners.get(key)?.provisioner === provisioner) worktreeProvisioners.delete(key);
    };
  };
  const worktreeProvisionerFor = (parent: HeadlessHubSession): DoomHubReservedWorktreeProvisioner | undefined => {
    let provisioner: DoomHubReservedWorktreeProvisioner | undefined;
    let priority = -1;
    for (const { mount, provisioner: candidate } of worktreeProvisioners.values()) {
      if (!belongs(mount, parent) || CHANNEL_PRIORITY[mount.scope] <= priority) continue;
      provisioner = candidate;
      priority = CHANNEL_PRIORITY[mount.scope];
    }
    return provisioner;
  };
  const selectedChannels = (session: HeadlessHubSession): StartedChannel[] => {
    const selected = new Map<string, StartedChannel>();
    for (const started of channels.values()) {
      if (!belongs(started.mount, session)) continue;
      const previous = selected.get(started.channel.frameType);
      if (!previous || CHANNEL_PRIORITY[started.mount.scope] > CHANNEL_PRIORITY[previous.mount.scope])
        selected.set(started.channel.frameType, started);
    }
    return [...selected.values()];
  };
  const selectedChannel = (session: HeadlessHubSession, frameType: string): StartedChannel | undefined =>
    selectedChannels(session).find((started) => started.channel.frameType === frameType);
  /**
   * One channel serves a session: the narrowest mount that reaches it. A package that
   * registers the same channel globally and per workspace would otherwise run two
   * sources against one session, and only the narrower one can publish or receive.
   *
   * Compared by mount scope rather than identity so a channel being started already
   * knows which sessions it is taking over.
   */
  const serves = (mount: DoomApiMount, frameType: string, session: HeadlessHubSession): boolean => {
    if (!belongs(mount, session)) return false;
    const current = selectedChannel(session, frameType);
    return current === undefined || CHANNEL_PRIORITY[mount.scope] >= CHANNEL_PRIORITY[current.mount.scope];
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

  const announceCommunicationReady = (sessionId: string): void => {
    const current = communicationEndpoints.get(sessionId);
    if (current?.ready !== true) return;
    for (const [peerSessionId, peer] of communicationEndpoints) {
      if (!peer.ready || !canCommunicate(sessionId, peerSessionId)) continue;
      for (const listener of current.readyListeners) listener(peerSessionId);
      for (const listener of peer.readyListeners) listener(sessionId);
    }
  };

  const bindCommunication = (sessionId: string): DoomSessionCommunicationEndpoint => {
    const existing = communicationEndpoints.get(sessionId);
    if (existing !== undefined) return existing.endpoint;
    const listeners = new Map<string, Set<(sourceSessionId: string, payload: unknown) => void>>();
    const readyListeners = new Set<(peerSessionId: string) => void>();
    let endpoint!: DoomSessionCommunicationEndpoint;
    const record = {
      listeners,
      readyListeners,
      ready: false,
      get endpoint() {
        return endpoint;
      },
    };
    endpoint = {
      sessionId,
      publish(targetSessionId, type, payload) {
        if (!canCommunicate(sessionId, targetSessionId)) return false;
        const target = communicationEndpoints.get(targetSessionId);
        if (target?.ready !== true) return false;
        for (const listener of target.listeners.get(type) ?? []) listener(sessionId, payload);
        return true;
      },
      subscribe(type, listener) {
        const current = listeners.get(type) ?? new Set<(sourceSessionId: string, payload: unknown) => void>();
        current.add(listener);
        listeners.set(type, current);
        return () => {
          current.delete(listener);
          if (current.size === 0) listeners.delete(type);
        };
      },
      onPeerReady(listener) {
        readyListeners.add(listener);
        if (!record.ready) {
          record.ready = true;
          announceCommunicationReady(sessionId);
        } else {
          for (const [peerSessionId, peer] of communicationEndpoints) {
            if (peer.ready && canCommunicate(sessionId, peerSessionId)) listener(peerSessionId);
          }
        }
        return () => readyListeners.delete(listener);
      },
      close() {
        if (communicationEndpoints.get(sessionId)?.endpoint !== endpoint) return;
        communicationEndpoints.delete(sessionId);
        listeners.clear();
        readyListeners.clear();
      },
    };
    communicationEndpoints.set(sessionId, record);
    return endpoint;
  };

  const queuedEvents: HeadlessHubEvent[] = [];
  let publishing = false;
  const emit = (event: HeadlessHubEvent): void => {
    if (closed) return;
    queuedEvents.push(event.kind === 'upsert' ? { ...event, session: present(event.session) } : event);
    if (publishing) return;
    publishing = true;
    try {
      for (let index = 0; index < queuedEvents.length; index += 1)
        for (const listener of listeners) listener(queuedEvents[index]);
    } finally {
      queuedEvents.length = 0;
      publishing = false;
    }
  };
  const sessionScopes = (): readonly DoomHubSessionScope[] => [...sessions.values()].map(scopeOf);
  const publish = (frameType: string, sessionId: string, payload: unknown, connectionId?: string): void => {
    if (!sessions.has(sessionId)) return;
    emit({ kind: 'channel', frameType, sessionId, payload, ...(connectionId === undefined ? {} : { connectionId }) });
  };

  /**
   * Hub-owned calls carry the hub credential, so a session API can tell them from a
   * browser call it must not trust. Browser traffic reaches a session API through
   * requestApi instead, and keeps the headers its caller sent.
   */
  const hubAuthenticated = (request: DoomHubSessionApiRequest): DoomHubSessionApiRequest => {
    const token = options.hubToken?.();
    if (token === undefined || token === '') return request;
    const headers = new Headers(request.headers);
    if (headers.has(AUTHORIZATION_HEADER)) return request;
    headers.set(AUTHORIZATION_HEADER, `Bearer ${token}`);
    return { ...request, headers };
  };

  const reservationsFor = (mount: DoomApiMount): DoomHubSessionReservations | undefined => {
    const reservations = options.sessionReservations;
    if (!reservations) return undefined;
    const check = (parentId: string): void => {
      const parent = sessions.get(parentId);
      if (!parent || !belongs(mount, parent)) throw new Error('Parent session is outside this mount.');
    };
    return {
      read: (id, parentId) => {
        check(parentId);
        return reservations.read(id, parentId);
      },
      prepare: (id, parentId, cwd) => {
        check(parentId);
        return reservations.prepare(id, parentId, cwd);
      },
      complete: (id, parentId) => {
        check(parentId);
        return reservations.complete(id, parentId);
      },
    };
  };
  const channelHost = (frameType: string, mount: DoomApiMount): DoomHubChannelHost => ({
    sessions: () =>
      sessionScopes().filter((scope) => {
        const session = sessions.get(scope.sessionId);
        return session !== undefined && serves(mount, frameType, session);
      }),
    sessionService: {
      reservations: reservationsFor(mount),
      create: async (request) => {
        // A workspace package may start a top-level session, placed in its own workspace.
        if (mount.scope === 'workspace' && request.parentSessionId === undefined) {
          if (request.reservationId !== undefined) throw new Error('A reserved session requires its owning parent.');
          if (options.createSession === undefined)
            throw new Error('The cockpit session service cannot create sessions in this host.');
          return options.createSession(request, { workspaceId: mount.workspaceId });
        }
        if (mount.scope !== 'global') {
          const parent = request.parentSessionId === undefined ? undefined : sessions.get(request.parentSessionId);
          if (!parent || !belongs(mount, parent)) throw new Error('Parent session is outside this mount.');
        }
        return sessionService.create(request);
      },
      close: async (id) => {
        const session = sessions.get(id);
        if (session === undefined) {
          const shutdown = sessionShutdowns.get(id);
          if (shutdown !== undefined) {
            if (!canClose(mount, shutdown.session)) throw new Error('Session is outside this mount.');
            await shutdown.promise;
          }
          return;
        }
        if (!canClose(mount, session)) throw new Error('Session is outside this mount.');
        await sessionService.close(id);
      },
      isLive: (id) => sessionService.isLive(id),
      registerReservedWorktreeProvisioner: (provisioner) => registerReservedWorktreeProvisioner(mount, provisioner),
      canCommunicate: (sourceId, targetId) => {
        const source = sessions.get(sourceId);
        return (
          source !== undefined && belongs(mount, source) && sessionService.canCommunicate?.(sourceId, targetId) === true
        );
      },
    },
    directEvents: {
      publish: (type, id, payload) => {
        const session = sessions.get(id);
        if (session && serves(mount, frameType, session)) directEvents.publish(type, id, payload);
      },
      subscribe: (type, id, listener, subscriptionOptions) => {
        const session = sessions.get(id);
        return session && serves(mount, frameType, session)
          ? directEvents.subscribe(type, id, listener, subscriptionOptions)
          : () => undefined;
      },
      close: () => undefined,
    },
    publish: (sessionId, payload) => {
      const session = sessions.get(sessionId);
      if (session && serves(mount, frameType, session)) publish(frameType, sessionId, payload);
    },
    publishToConnection: (connectionId, sessionId, payload) => {
      const session = sessions.get(sessionId);
      if (connectionId === '' || !session || !serves(mount, frameType, session)) return false;
      publish(frameType, sessionId, payload, connectionId);
      return true;
    },
    requestSessionApi: async (scope, request) => {
      const session = sessions.get(scope.sessionId);
      if (!session || !belongs(mount, session)) return Response.json({ error: 'Session not found.' }, { status: 404 });
      if (options.requestSessionApi === undefined)
        return Response.json({ error: 'Session API unavailable.' }, { status: 404 });
      return options.requestSessionApi(scope, hubAuthenticated(request));
    },
    ...(options.computerUse === undefined
      ? {}
      : {
          computerUse: {
            get available() {
              return options.computerUse!.available;
            },
            request(scope, request) {
              const session = sessions.get(scope.sessionId);
              if (!session || !belongs(mount, session)) throw new Error('Computer-use session is outside this mount.');
              return options.computerUse!.request(scopeOf(session), request);
            },
          },
        }),
    onNotice: (message) => options.onNotice?.(message),
  });

  const startChannel = (channel: DoomHubChannel, mount: DoomApiMount): StartedChannel | undefined => {
    const key = `${mountKey(mount)}:${channel.frameType}`;
    if (channels.has(key)) {
      options.onNotice?.(`hub channel '${channel.frameType}' is already registered`);
      return undefined;
    }
    try {
      const displaced = new Map<string, StartedChannel>();
      for (const session of sessions.values()) {
        if (!belongs(mount, session)) continue;
        const previous = selectedChannel(session, channel.frameType);
        if (previous !== undefined) displaced.set(session.id, previous);
      }
      const source = channel.start(channelHost(channel.frameType, mount));
      const started = { channel, source, mount };
      channels.set(key, started);
      for (const session of sessions.values()) {
        if (selectedChannel(session, channel.frameType) !== started) continue;
        displaced.get(session.id)?.source.sessionRemoved?.(session.id);
        source.sessionAdded?.(scopeOf(session));
      }
      return started;
    } catch (error) {
      options.onNotice?.(`hub channel '${channel.frameType}' failed (${String(error)})`);
      return undefined;
    }
  };

  const releaseChannel = (channel: DoomHubChannel, started: StartedChannel): void => {
    const key = `${mountKey(started.mount)}:${channel.frameType}`;
    if (channels.get(key) !== started) return;
    const served = [...sessions.values()].filter((session) => selectedChannel(session, channel.frameType) === started);
    channels.delete(key);
    started.source.close();
    for (const session of served) selectedChannel(session, channel.frameType)?.source.sessionAdded?.(scopeOf(session));
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

  const unregisterSession = (sessionId: string, closeOptions?: HeadlessSessionCloseOptions): void => {
    const current = sessions.get(sessionId);
    if (current === undefined) return;
    const cleanup = sessionCleanups.get(sessionId);
    if (cleanup !== undefined) subscriptions.delete(cleanup);
    communicationEndpoints.get(sessionId)?.endpoint.close();
    // Let scoped sources dispatch their final stop while the live-session boundary still admits it.
    try {
      for (const { source } of selectedChannels(current)) source.sessionRemoved?.(sessionId);
      options.computerUse?.forgetSession?.(sessionId);
    } finally {
      // A failing external stop must not leave a closed host registered.
      sessions.delete(sessionId);
      activities.delete(sessionId);
      sessionCleanups.delete(sessionId);
      presentationCleanups.get(sessionId)?.();
      presentationCleanups.delete(sessionId);
      avatarIcons.delete(sessionId);
      directEvents.clearSession?.(sessionId);
    }
    emit({ kind: 'removed', sessionId, ...(closeOptions?.keepDormant === true ? { dormant: true as const } : {}) });
  };

  const startSessionShutdown = (
    session: HeadlessHubSession,
    closeOptions?: HeadlessSessionCloseOptions,
  ): Promise<void> => {
    const existing = sessionShutdowns.get(session.id);
    if (existing !== undefined) return existing.promise;
    const shutdown = { session, promise: Promise.resolve(), pending: true };
    const promise = Promise.resolve().then(() =>
      closeOptions === undefined
        ? options.manager.closeSession(session.id)
        : options.manager.closeSession(session.id, closeOptions),
    );
    shutdown.promise = promise;
    sessionShutdowns.set(session.id, shutdown);
    void promise.then(
      () => {
        shutdown.pending = false;
        if (sessionShutdowns.get(session.id) === shutdown) sessionShutdowns.delete(session.id);
      },
      () => {
        shutdown.pending = false;
      },
    );
    return promise;
  };

  const register = (session: HeadlessHubSession): void => {
    if (closed) throw new Error('The headless hub is closed.');
    if (sessions.has(session.id)) throw new Error(`Session '${session.id}' is already registered.`);
    if (sessionShutdowns.get(session.id)?.pending) throw new Error(`Session '${session.id}' is still shutting down.`);
    // A failed shutdown stays visible to scoped closers until the id is reused. Reopening
    // the session is that reuse, so it must not be blocked by the stale failure.
    sessionShutdowns.delete(session.id);
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
    announceCommunicationReady(session.id);
    // Branch changes happen inside runs, so the status is read at start and after each settle.
    const refreshGit = (): void => {
      void (options.readGitStatus ?? readSessionGitStatus)(session.cwd).then(
        (git) => {
          if (closed || sessions.get(session.id)?.host !== session.host) return;
          if (git?.branch === current.git?.branch && git?.dirty === current.git?.dirty) return;
          const { git: _previous, ...rest } = current;
          current = git === undefined ? rest : { ...rest, git };
          sessions.set(session.id, current);
          emit({ kind: 'upsert', session: current });
        },
        (error: unknown) =>
          options.onNotice?.(
            `session ${session.id} git status failed (${error instanceof Error ? error.message : String(error)})`,
          ),
      );
    };
    const stopPresentation = session.host.onPresentationFrame((frame) => {
      if (sessions.get(session.id)?.host !== session.host) return;
      const type = typeof frame.type === 'string' ? frame.type : '';
      const entry = frame.entry as { customType?: unknown } | undefined;
      if (type === 'entry_appended' && entry?.customType === DOOM_NOTIFICATION_ENTRY_TYPE) {
        emit({ kind: 'frame', sessionId: session.id, frame });
        return;
      }
      // Streaming updates belong to the session presentation. Replicating the
      // hub's growing event list for every token makes model output quadratic.
      if (
        type !== 'agent_start' &&
        type !== 'agent_settled' &&
        type !== 'message_end' &&
        type !== 'session_info_changed' &&
        type !== 'extension_ui_request' &&
        type !== 'extension_ui_answered'
      )
        return;
      const now = new Date().toISOString();
      const phase = type === 'agent_start' ? 'turn' : type === 'agent_settled' ? 'idle' : current.phase;
      const phaseChanged = phase !== current.phase;
      const method = typeof frame.method === 'string' ? frame.method : '';
      const dialog = type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(method);
      const awaitingInput = dialog
        ? true
        : type === 'extension_ui_answered' || type === 'agent_settled'
          ? false
          : current.awaitingInput;
      current = {
        ...current,
        name: type === 'session_info_changed' && typeof frame.name === 'string' ? frame.name : current.name,
        updatedAt: now,
        phase,
        phaseSince: phaseChanged ? now : current.phaseSince,
        everPrompted: current.everPrompted || type === 'agent_start',
        awaitingInput,
        ...(type === 'agent_settled' ? { lastSettledAt: now } : {}),
      };
      sessions.set(session.id, current);
      emit({ kind: 'upsert', session: current });
      // Only the prompt text travels: options and defaults stay with the focused presentation.
      if (dialog) {
        const text = (key: string) => (typeof frame[key] === 'string' ? { [key]: frame[key] } : {});
        emit({
          kind: 'frame',
          sessionId: session.id,
          frame: { type, ...text('id'), method, ...text('title'), ...text('message') },
        });
      }
      if (type === 'agent_settled') refreshGit();
    });
    let registered = false;
    const applyProfile = (profileName: string | undefined): void => {
      if (closed || sessions.get(session.id)?.host !== session.host) return;
      let identity: HeadlessProfileIdentity | undefined;
      if (profileName) {
        const root = (session.workspaceId && workspaces.get(session.workspaceId)?.root) || session.cwd;
        try {
          identity = options.resolveProfileIdentity?.(root, profileName);
        } catch (error) {
          options.onNotice?.(
            `session ${session.id} profile "${profileName}" could not be resolved (${error instanceof Error ? error.message : String(error)})`,
          );
        }
      }
      const icon = identity?.icon;
      if (icon) avatarIcons.set(session.id, icon);
      else avatarIcons.delete(session.id);
      const profile: HeadlessSessionProfile | undefined = profileName
        ? {
            name: profileName,
            ...(identity?.displayName ? { displayName: identity.displayName } : {}),
            ...(icon
              ? { iconVersion: crypto.createHash('sha256').update(icon).digest('hex').slice(0, ICON_VERSION_LENGTH) }
              : {}),
          }
        : undefined;
      const previous = current.profile;
      if (
        previous?.name === profile?.name &&
        previous?.displayName === profile?.displayName &&
        previous?.iconVersion === profile?.iconVersion
      )
        return;
      const { profile: _previous, ...rest } = current;
      current = profile === undefined ? rest : { ...rest, profile };
      sessions.set(session.id, current);
      if (registered) emit({ kind: 'upsert', session: current });
    };
    const stopSelection = session.host.onSelection?.((selection) => applyProfile(selection.profile));
    presentationCleanups.set(session.id, () => {
      stopPresentation();
      stopSelection?.();
    });
    for (const { source } of selectedChannels(current)) source.sessionAdded?.(scopeOf(session));
    const active = (): boolean => sessions.get(session.id)?.host === session.host && !closed;
    const cleanup = (): void => {
      subscriptions.delete(cleanup);
      sessionCleanups.delete(session.id);
      if (!active()) return;
      void closeSession(session.id).catch((error: unknown) =>
        options.onNotice?.(
          `session ${session.id} cleanup failed (${error instanceof Error ? error.message : String(error)})`,
        ),
      );
    };
    sessionCleanups.set(session.id, cleanup);
    void session.host.runtime.exited.then(cleanup, cleanup);
    subscriptions.add(cleanup);
    registered = true;
    emit({ kind: 'upsert', session: current });
    refreshGit();
  };

  const closeSession = async (sessionId: string, closeOptions?: HeadlessSessionCloseOptions): Promise<void> => {
    const pending = sessionShutdowns.get(sessionId);
    if (pending !== undefined) {
      await pending.promise;
      return;
    }
    const session = sessions.get(sessionId);
    if (session === undefined) return;
    unregisterSession(sessionId, closeOptions);
    await startSessionShutdown(session, closeOptions);
  };

  const promptTarget = (sessionId: string, parentSessionId: string | undefined): HeadlessHubSession => {
    const session = closed ? undefined : sessions.get(sessionId);
    if (session === undefined) throw new Error('The session is not live.');
    if (parentSessionId !== undefined && session.parentSessionId !== parentSessionId)
      throw new Error('Only the parent session can drive this session.');
    return session;
  };

  sessionService = {
    create: async (request) => {
      if (options.createSession === undefined)
        throw new Error('The cockpit session service cannot create sessions in this host.');
      return options.createSession(request);
    },
    close: closeSession,
    isLive: (sessionId) => !closed && sessions.has(sessionId),
    prompt: async (sessionId, text, promptOptions) => {
      promptOptions?.signal?.throwIfAborted();
      const { settled } = await promptTarget(sessionId, promptOptions?.parentSessionId).host.runtime.submitPrompt(text);
      return { settled };
    },
    abort: async (sessionId, abortOptions) => {
      await promptTarget(sessionId, abortOptions?.parentSessionId).host.runtime.abort();
    },
    steer: async (sessionId, message, steerOptions) => {
      await promptTarget(sessionId, steerOptions?.parentSessionId).host.runtime.steer(message);
    },
    release: async (sessionId, releaseOptions) => {
      promptTarget(sessionId, releaseOptions?.parentSessionId);
      await closeSession(sessionId, { keepDormant: true });
    },
    reservations: options.sessionReservations,
    provisionReservedWorktree: async (request) => {
      const parent = sessions.get(request.parentSessionId);
      const provisioner = parent === undefined ? undefined : worktreeProvisionerFor(parent);
      if (provisioner === undefined) throw new Error('Automatic conversation worktree provisioning is unavailable.');
      return provisioner(request);
    },
    registerReservedWorktreeProvisioner: (provisioner) =>
      registerReservedWorktreeProvisioner({ scope: 'global' }, provisioner),
    canCommunicate,
    bindCommunication,
  };

  const mountFacets = async (
    facets: readonly (DoomServerFacet | LoadedServerFacet)[],
    suppliedContext?: DoomApiContext,
  ): Promise<void> => {
    if (closed) throw new Error('The headless hub is closed.');
    const context: DoomApiContext = suppliedContext ?? {
      scope: 'global',
      ...(options.hubToken?.() === undefined ? {} : { hubToken: options.hubToken() }),
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
      if (mount.scope === 'workspace') {
        const workspace = { id: mount.workspaceId, root: context.workspaceRoot!, available: true };
        workspaces.set(mount.workspaceId, workspace);
        emit({ kind: 'workspace_upsert', workspace });
      }
    } catch (error) {
      host.dispose();
      throw error;
    }
  };

  return {
    sessionService,
    directEvents,
    ...(options.computerUse === undefined ? {} : { computerUse: options.computerUse }),
    snapshot: () => [...sessions.values()].map(present),
    session: (sessionId) => {
      const session = sessions.get(sessionId);
      return session === undefined ? undefined : present(session);
    },
    setPendingSessionSetups(sessionId, pending) {
      if (JSON.stringify(pendingSetups.get(sessionId) ?? []) === JSON.stringify(pending)) return;
      pendingSetups.set(sessionId, Object.freeze([...pending]));
      const session = sessions.get(sessionId);
      if (session) emit({ kind: 'upsert', session: present(session) });
    },
    setSessionActivity(sessionId, activity) {
      const session = sessions.get(sessionId);
      if (session === undefined) return;
      const next: DoomSessionActivity | undefined =
        activity === undefined
          ? undefined
          : Object.freeze({
              label: activity.label.slice(0, MAX_ACTIVITY_LABEL),
              ...(activity.attention === true ? { attention: true } : {}),
              ...(activity.since === undefined ? {} : { since: activity.since }),
            });
      if (JSON.stringify(activities.get(sessionId)) === JSON.stringify(next)) return;
      if (next === undefined) activities.delete(sessionId);
      else activities.set(sessionId, next);
      emit({ kind: 'upsert', session: present(session) });
    },
    runtime: (sessionId) => sessions.get(sessionId)?.host.runtime,
    sessionAvatar(sessionId) {
      const match = ICON_DATA_URL.exec(avatarIcons.get(sessionId) ?? '');
      const mimeType = match?.[1];
      if (match === null || !(PROFILE_ICON_MIME_TYPES as readonly string[]).includes(mimeType ?? '')) return undefined;
      return { mimeType: mimeType!, bytes: Buffer.from(match[2]!, 'base64') };
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register,
    notifySessionRemoved(sessionId) {
      emit({ kind: 'removed', sessionId });
    },
    mountFacets,
    workspaces: () => [...workspaces.values()],
    registerWorkspace(workspace) {
      workspaces.set(workspace.id, workspace);
      emit({ kind: 'workspace_upsert', workspace });
    },
    admitWorkspace: async (request) => {
      if (!options.admitWorkspace) throw new Error('Workspace admission is unavailable.');
      return options.admitWorkspace(request);
    },
    async removeWorkspace(id) {
      if ([...sessions.values()].some((session) => session.workspaceId === id))
        throw new Error('Workspace still has live sessions.');
      const key = mountKey({ scope: 'workspace', workspaceId: id });
      const mounted = mounts.get(key);
      if (!workspaces.has(id)) return;
      options.onWorkspaceRemoved?.(id);
      workspaces.delete(id);
      emit({ kind: 'workspace_removed', workspaceId: id });
      if (!mounted) return;
      mounts.delete(key);
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
    pluginRegistry,
    invokePlugin: (call, direction, caller) => pluginRegistry.invoke(call, direction, caller),
    async create(sessionOptions) {
      const id = sessionOptions.sessionId;
      if (closed) throw new Error('The headless hub is closed.');
      // Checked before building the host: once it exists, a refusal has to close it, and a
      // duplicate id would then close the live session that already owns the id.
      if (sessions.has(id)) throw new Error(`Session '${id}' is already registered.`);
      if (sessionShutdowns.get(id)?.pending) throw new Error(`Session '${id}' is still shutting down.`);
      const host = await options.manager.create(sessionOptions);
      const settledAt = await lastSettledAt(host);
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
        ...(settledAt === undefined ? {} : { everPrompted: true, lastSettledAt: settledAt }),
        host,
      };
      try {
        register(session);
      } catch (error) {
        // Registration can fail after publishing the host into the session map.
        // Roll back only our host, never a different session that owns this id.
        if (sessions.get(id)?.host === host) {
          try {
            unregisterSession(id);
          } catch (cleanupError) {
            options.onNotice?.(`Session '${id}' registration rollback failed: ${String(cleanupError)}`);
          }
        }
        // The hub closed, or a racing create took the id, while this host was starting.
        await Promise.resolve(options.manager.closeSession(id)).catch((closeError: unknown) =>
          options.onNotice?.(`Session '${id}' could not be closed after a failed registration: ${String(closeError)}`),
        );
        throw error;
      }
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
    receiveChannel(
      sessionId,
      frameType,
      payload,
      connectionId,
      desktopAuthorized = false,
      computerUseAuthorized = false,
    ) {
      if (connectionId === '') return;
      const session = sessions.get(sessionId);
      const started = session && selectedChannels(session).find(({ channel }) => channel.frameType === frameType);
      if (session === undefined || started === undefined) return;
      started.channel.receive?.(scopeOf(session), payload, {
        connectionId,
        ...(desktopAuthorized ? { desktopAuthorized: true } : {}),
        ...(computerUseAuthorized ? { computerUseAuthorized: true } : {}),
      } satisfies DoomHubChannelConnection);
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
      const shutdowns: Promise<void>[] = [...sessionShutdowns.values()]
        .filter(({ pending }) => pending)
        .map(({ promise }) => promise);
      for (const id of ids) {
        const session = sessions.get(id);
        if (session !== undefined && !sessionShutdowns.has(id)) shutdowns.push(startSessionShutdown(session));
      }
      sessions.clear();
      const outcomes = await Promise.allSettled(shutdowns);
      for (const outcome of outcomes) if (outcome.status === 'rejected') failures.push(outcome.reason);
      if (failures.length) throw new AggregateError(failures, 'Mount shutdown failed');
    },
  };
}
