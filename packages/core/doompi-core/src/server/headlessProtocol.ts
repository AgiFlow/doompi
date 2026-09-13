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
    case 'channel':
      return { type: event.frameType, sessionId: event.sessionId, payload: event.payload as JsonValue };
  }
}

function managementHost(hub: HeadlessHub, threads: ThreadJournals): RoutedServerServiceHost {
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
        state.state.events.push({ sequence, frame });
        if (state.state.events.length > MAX_HUB_EVENTS) state.state.events.shift();
        state.publish(BACKGROUND_CONTEXT);
      };
      publish({ type: 'sessions_snapshot', sessions: hub.snapshot().map(sessionView) });
      const stopEvents = hub.onEvent((event) => {
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
  telemetry?: ServerTelemetry,
): ServerHost<DoomSessionMetadata> {
  const serviceHosts = new Map<string, ReturnType<typeof createAgentServerService>>();
  const serviceHost = (session: HeadlessHubSession): ReturnType<typeof createAgentServerService> => {
    const current = serviceHosts.get(session.id);
    if (current) return current;
    const created = createAgentServerService({
      runtime: session.host.runtime,
      onPresentationFrame: (listener) => session.host.onPresentationFrame(listener),
      respondToExtensionUi: (frame) => session.host.respondToExtensionUi(frame),
      readThreadTranscript: (threadId, request, context) => threads.readPage(session.id, threadId, request, context),
      sessionId: session.id,
      sessionName: session.name,
      cwd: session.cwd,
      createdAt: metadataOf(session).createdAt,
      telemetry,
    });
    serviceHosts.set(session.id, created);
    return created;
  };
  return {
    serverServices: managementHost(hub, threads),
    async resolveSession(sessionId) {
      const session = hub.session(sessionId);
      if (!session) throw new SessionNotFoundError(`No session ${sessionId}`);
      return metadataOf(session);
    },
    async openSession(metadata, context): Promise<RoutedSessionHandle> {
      const session = hub.session(metadata.id);
      if (!session) throw new SessionNotFoundError(`No session ${metadata.id}`);
      return serviceHost(session).openSession(metadata, context);
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
  telemetry?: ServerTelemetry;
  onNotice?: (message: string) => void;
}): Promise<HeadlessProtocol> {
  const listener = createPiWebSocketListener({ onError: (error) => options.onNotice?.(error.message) });
  const threads = createThreadJournals({
    resolve: (sessionId, threadId) => options.hub.threadJournal(sessionId, threadId),
  });
  const server = await new Server(protocolHost(options.hub, threads, options.telemetry), {
    listeners: [listener],
    serverId: DOOM_COCKPIT_SERVER_ID,
    onError: (error) => options.onNotice?.(`headless protocol error (${error.message})`),
  }).start();
  return {
    accept: (socket) => listener.accept(socket),
    async close() {
      threads.close();
      await server.close();
    },
  };
}
