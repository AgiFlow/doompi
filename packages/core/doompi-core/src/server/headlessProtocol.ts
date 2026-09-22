import { randomUUID } from 'node:crypto';

import {
  createRemoteServiceEndpoint,
  RemoteServiceProvider,
  replicatedState,
  type JsonValue,
  type RemoteServiceEndpoint,
} from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { RoutedServerServiceHost, RoutedSessionHandle, ServerHost } from '@earendil-works/pi-server';
import { Server, SessionNotFoundError } from '@earendil-works/pi-server';

import { DoomPluginService } from '../exports/pluginProtocol';
import {
  DOOM_COCKPIT_SERVER_ID,
  DoomHubService,
  DoomSessionManagementService,
  type HubService,
  type ProtocolEvent,
} from '../exports/sessionProtocol';
import { createAgentServerService, type DoomSessionMetadata } from '../pi/piSessionRuntime';
import { createPiWebSocketListener, type PiListenerSocket } from '../pi/piWebSocketListener';
import type { DoomSocketMount } from '../schemas/packageApi';
import type { OpenSessionRecord } from '../services/openSessionRegistry';
import type { ServerTelemetry } from '../services/serverTelemetry';
import type { HeadlessHub, HeadlessHubEvent, HeadlessHubSession } from './headlessHub';
import { createThreadJournals, type ThreadJournals } from './threadJournals';

const MAX_HUB_EVENTS = 1_024;

type ProtocolHandler = NonNullable<ReturnType<ReturnType<typeof createPiWebSocketListener>['accept']>>;
type HubFrame = { type: string; [key: string]: JsonValue };

function sessionView(session: HeadlessHubSession): Record<string, JsonValue> {
  return {
    id: session.id,
    ...(session.workspaceId === undefined ? {} : { workspaceId: session.workspaceId }),
    ...(session.webComposition === undefined ? {} : { webComposition: { ...session.webComposition } }),
    name: session.name,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt ?? session.createdAt,
    phase: session.phase ?? 'idle',
    phaseSince: session.phaseSince ?? session.createdAt,
    attach: 'attached',
    pendingMessageCount: session.pendingMessageCount ?? 0,
    everPrompted: session.everPrompted ?? false,
    awaitingInput: session.awaitingInput ?? false,
    ...(session.lastSettledAt === undefined ? {} : { lastSettledAt: session.lastSettledAt }),
    ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
    ...(session.sessionProvenance === undefined ? {} : { sessionProvenance: session.sessionProvenance }),
    ...(session.pendingSetups === undefined
      ? {}
      : {
          pendingSetups: session.pendingSetups.map((setup) => ({
            id: setup.id,
            name: setup.name,
            createdAt: setup.createdAt,
            ...(setup.cwd === undefined ? {} : { cwd: setup.cwd }),
          })),
        }),
  };
}

/**
 * A recorded session with no runtime behind it yet.
 *
 * Carries the same field set as a live session so the rail keys both by id and
 * swaps one for the other in place once the server reopens the journal.
 */
function dormantView(record: OpenSessionRecord): Record<string, JsonValue> {
  return {
    id: record.sessionId,
    workspaceId: record.workspaceId,
    name: record.name,
    cwd: record.cwd,
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
    phase: 'idle',
    phaseSince: record.createdAt,
    attach: 'attached',
    pendingMessageCount: 0,
    everPrompted: false,
    awaitingInput: false,
    dormant: true,
    ...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
    ...(record.sessionProvenance === undefined ? {} : { sessionProvenance: record.sessionProvenance }),
  };
}

function endpointAttachment(endpoint: RemoteServiceEndpoint): {
  invokeService: RemoteServiceEndpoint['invoke'];
  release(): void;
} {
  return {
    invokeService: (call, publish, context) => endpoint.invoke(call, publish, context),
    release: () => endpoint.dispose(),
  };
}

function metadataOf(session: HeadlessHubSession): DoomSessionMetadata {
  const createdAt = Date.parse(session.createdAt);
  return {
    id: session.id,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    storageVersion: 1,
    cwd: session.cwd,
    sessionName: session.name,
  };
}

function frameOf(event: HeadlessHubEvent): HubFrame {
  switch (event.kind) {
    case 'upsert':
      return { type: 'session_upsert', session: sessionView(event.session) };
    case 'removed':
      return { type: 'session_removed', sessionId: event.sessionId };
    case 'workspace_upsert':
      return {
        type: 'workspace_upsert',
        workspace: {
          id: event.workspace.id,
          root: event.workspace.root,
          available: event.workspace.available !== false,
        },
      };
    case 'workspace_removed':
      return { type: 'workspace_removed', workspaceId: event.workspaceId };
    case 'channel':
      return { type: event.frameType, sessionId: event.sessionId, payload: event.payload as JsonValue };
  }
}

function permitsSession(hub: HeadlessHub, mount: DoomSocketMount, sessionId: string): boolean {
  const session = hub.session(sessionId);
  return (
    session !== undefined &&
    (mount.scope === 'global' ||
      (session.workspaceId === mount.workspaceId && (mount.scope === 'workspace' || mount.sessionId === sessionId)))
  );
}

function permitsDormant(mount: DoomSocketMount, record: OpenSessionRecord): boolean {
  if (mount.scope === 'global') return true;
  if (record.workspaceId !== mount.workspaceId) return false;
  return mount.scope === 'workspace' || mount.sessionId === record.sessionId;
}

function managementHost(
  hub: HeadlessHub,
  threads: ThreadJournals,
  mount: DoomSocketMount,
  dormantSessions: () => readonly OpenSessionRecord[],
): RoutedServerServiceHost {
  return {
    attachClient(presentation) {
      const connectionId = randomUUID();
      const subscriptions = new Set<string>();
      const threadSubscriptions = new Set<string>();
      const state = replicatedState<{ events: ProtocolEvent[] }>({ events: [] });
      let sequence = 0;
      let released = false;
      const publish = (frame: HubFrame): void => {
        sequence += 1;
        state.change(BACKGROUND_CONTEXT, (draft) => {
          draft.events.push({ sequence, frame });
          if (draft.events.length > MAX_HUB_EVENTS) draft.events.shift();
        });
      };
      const visible = new Set(
        hub
          .snapshot()
          .filter((session) => permitsSession(hub, mount, session.id))
          .map((session) => session.id),
      );
      publish({
        type: 'sessions_snapshot',
        sessions: [
          ...hub
            .snapshot()
            .filter((session) => visible.has(session.id))
            .map(sessionView),
          ...dormantSessions()
            .filter((record) => !visible.has(record.sessionId) && permitsDormant(mount, record))
            .map(dormantView),
        ],
      });
      publish({
        type: 'workspaces_snapshot',
        workspaces: hub
          .workspaces()
          .filter((workspace) => mount.scope === 'global' || workspace.id === mount.workspaceId)
          .map((workspace) => ({
            id: workspace.id,
            root: workspace.root,
            available: workspace.available !== false,
          })),
      });
      const stopEvents = hub.onEvent((event) => {
        if (event.kind === 'workspace_upsert' || event.kind === 'workspace_removed') {
          const workspaceId = event.kind === 'workspace_upsert' ? event.workspace.id : event.workspaceId;
          if (mount.scope !== 'global' && mount.workspaceId !== workspaceId) return;
          publish(frameOf(event));
          return;
        }
        if (event.kind === 'removed') {
          if (!visible.delete(event.sessionId)) return;
        } else {
          const id = event.kind === 'upsert' ? event.session.id : event.sessionId;
          if (!permitsSession(hub, mount, id)) return;
          if (event.kind === 'upsert') visible.add(id);
        }
        if (event.kind === 'channel') {
          if (!subscriptions.has(event.sessionId)) return;
          if (event.connectionId !== undefined && event.connectionId !== connectionId) return;
        }
        publish(frameOf(event));
      });
      const stopThreadFrames = threads.onFrame((event) => {
        if (!threadSubscriptions.has(`${event.sessionId}\n${event.threadId}`)) return;
        publish({
          type: 'thread_frame',
          sessionId: event.sessionId,
          threadId: event.threadId,
          frame: event.frame as JsonValue,
        });
      });
      const service: HubService = {
        state,
        async send(frame) {
          const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : undefined;
          if (mount.scope !== 'global' && sessionId !== undefined && !permitsSession(hub, mount, sessionId))
            throw new Error('Session is outside this WebSocket scope.');
          if (frame.type === 'subscribe' && sessionId !== undefined) {
            if (!hub.session(sessionId)) return;
            subscriptions.add(sessionId);
            for (const channelFrame of hub.channelFrames(sessionId)) publish(channelFrame as HubFrame);
            return;
          }
          if (frame.type === 'unsubscribe' && sessionId !== undefined) {
            subscriptions.delete(sessionId);
            return;
          }
          const threadId = typeof frame.threadId === 'string' ? frame.threadId : undefined;
          if ((frame.type === 'subscribe_thread' || frame.type === 'unsubscribe_thread') && threadId !== undefined) {
            const key = `${sessionId ?? ''}\n${threadId}`;
            if (sessionId === undefined) return;
            if (frame.type === 'unsubscribe_thread') {
              if (threadSubscriptions.delete(key)) threads.unsubscribe(sessionId, threadId);
              return;
            }
            if (threadSubscriptions.has(key)) return;
            threadSubscriptions.add(key);
            publish({
              type: 'thread_backlog',
              sessionId,
              threadId,
              frames: threads.subscribe(sessionId, threadId) as JsonValue,
            });
            return;
          }
          if (sessionId !== undefined) hub.receiveChannel(sessionId, frame.type, frame.payload, connectionId);
        },
      };
      const provider = new RemoteServiceProvider([
        { service: DoomSessionManagementService, mode: 'singleton' },
        { service: DoomHubService, mode: 'singleton' },
        { service: DoomPluginService, mode: 'singleton' },
      ]);
      provider.provide(DoomHubService, service);
      provider.provide(DoomPluginService, {
        async invoke(call) {
          if (mount.scope !== 'global') {
            const permitted =
              call.mount.scope === 'session'
                ? permitsSession(hub, mount, call.mount.sessionId)
                : mount.scope === 'workspace' &&
                  call.mount.scope === 'workspace' &&
                  call.mount.workspaceId === mount.workspaceId;
            if (!permitted) throw new Error('Plugin is outside this WebSocket scope.');
          }
          return (await hub.invokePlugin(call, 'client-to-server', { connectionId })) as JsonValue;
        },
      });
      provider.provide(DoomSessionManagementService, {
        attach: (sessionId, context) => presentation.attachSession(sessionId, context),
        detach: (context) => presentation.detachSession(context),
      });
      const endpoint = createRemoteServiceEndpoint(provider);
      const attachment = endpointAttachment(endpoint);
      return {
        invokeService: attachment.invokeService,
        release() {
          if (released) return;
          released = true;
          stopEvents();
          stopThreadFrames();
          for (const key of threadSubscriptions) {
            const [sessionId, threadId] = key.split('\n');
            if (sessionId !== undefined && threadId !== undefined) threads.unsubscribe(sessionId, threadId);
          }
          threadSubscriptions.clear();
          subscriptions.clear();
          hub.disconnectChannels(connectionId);
          provider.dispose();
          attachment.release();
        },
      };
    },
  };
}

function protocolHost(
  hub: HeadlessHub,
  threads: ThreadJournals,
  telemetry: ServerTelemetry | undefined,
  mount: DoomSocketMount,
  dormantSessions: () => readonly OpenSessionRecord[],
): ServerHost<DoomSessionMetadata> {
  return {
    serverServices: managementHost(hub, threads, mount, dormantSessions),
    async resolveSession(sessionId) {
      const session = hub.session(sessionId);
      if (!session || !permitsSession(hub, mount, session.id))
        throw new SessionNotFoundError(`No session ${sessionId}`);
      return metadataOf(session);
    },
    async openSession(metadata, context): Promise<RoutedSessionHandle> {
      const session = hub.session(metadata.id);
      if (!session || !permitsSession(hub, mount, session.id))
        throw new SessionNotFoundError(`No session ${metadata.id}`);
      const service = createAgentServerService({
        runtime: session.host.runtime,
        onPresentationFrame: (listener) => session.host.onPresentationFrame(listener),
        respondToExtensionUi: (frame) => session.host.respondToExtensionUi(frame),
        readThreadTranscript: (threadId, request, readContext) =>
          threads.readPage(session.id, threadId, request, readContext),
        sessionId: session.id,
        sessionName: session.name,
        cwd: session.cwd,
        createdAt: metadataOf(session).createdAt,
        telemetry,
      });
      const handle = await service.openSession(metadata, context);
      return {
        ...handle,
        terminated: session.host.runtime.exited.then(async () => {
          await handle.close(BACKGROUND_CONTEXT);
          return undefined;
        }),
      };
    },
  };
}

export interface HeadlessProtocol {
  accept(socket: PiListenerSocket): ProtocolHandler | undefined;
  close(): Promise<void>;
}

/** Hosts the browser's Pi 0.85 connection directly over the process-local hub. */
export async function createHeadlessProtocol(options: {
  hub: HeadlessHub;
  mount?: DoomSocketMount;
  telemetry?: ServerTelemetry;
  onNotice?: (message: string) => void;
  /** Recorded sessions the server has not reopened; they join the first snapshot only. */
  dormantSessions?: () => readonly OpenSessionRecord[];
}): Promise<HeadlessProtocol> {
  const listener = createPiWebSocketListener({ onError: (error) => options.onNotice?.(error.message) });
  const threads = createThreadJournals({
    resolve: (sessionId, threadId) => options.hub.threadJournal(sessionId, threadId),
  });
  const server = await new Server(
    protocolHost(options.hub, threads, options.telemetry, options.mount ?? { scope: 'global' }, () =>
      options.dormantSessions === undefined ? [] : options.dormantSessions(),
    ),
    {
      listeners: [listener],
      serverId: DOOM_COCKPIT_SERVER_ID,
      onError: (error) => options.onNotice?.(`headless protocol error (${error.message})`),
    },
  ).start();
  let closing: Promise<void> | undefined;
  return {
    accept: (socket) => listener.accept(socket),
    close() {
      closing ??= (async () => {
        threads.close();
        await server.close();
      })();
      return closing;
    },
  };
}
