import { createRemoteServiceBinding, type RemoteServiceBinding } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Client, createClientServiceTransport } from '@earendil-works/pi-client';
import {
  DOOM_COCKPIT_SERVER_ID,
  DoomSessionManagementService,
  DoomSessionService,
  type SessionServiceState,
} from '@agimon-ai/doompi-extension-contracts/session-protocol';
import { createProtocolTransport, protocolSocketUrl } from '../lib/piTransport.ts';
import { recordBrowserPerformance } from '../lib/browserTelemetry.ts';
import { toQueuedEntries, toTimelineEntries } from '../lib/protocolTimeline.ts';
import { applyProtocolQueue, applyProtocolTranscript, releaseProtocolTranscript } from '../stores/sessionStore.ts';

/** How long to wait before dialling again after the protocol socket drops. */
const RECONNECT_MS = 700;

export interface ProtocolRuntime {
  /** Points the runtime at the session the page is showing, or at none. */
  focus(sessionId: string | null): void;
  stop(): void;
}

/** Runs Pi 0.85's routed client and Chord session binding for the visible session. */
export function startProtocolRuntime(location: Location = window.location): ProtocolRuntime {
  const client = new Client({
    serverId: DOOM_COCKPIT_SERVER_ID,
    transportFactory: createProtocolTransport(protocolSocketUrl(location)),
  });
  let binding: RemoteServiceBinding | undefined;
  let unsubscribe: (() => void) | undefined;
  let focused: string | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let generation = 0;

  const publish = (sessionId: string, state: SessionServiceState): void => {
    applyProtocolTranscript(sessionId, toTimelineEntries(state.snapshot.transcript), state.snapshot.phase !== 'idle');
    applyProtocolQueue(sessionId, toQueuedEntries(state.snapshot.queuedSteer));
  };

  const release = async (): Promise<void> => {
    unsubscribe?.();
    unsubscribe = undefined;
    const previous = binding;
    binding = undefined;
    if (focused !== null) releaseProtocolTranscript(focused);
    if (previous) await previous.dispose(BACKGROUND_CONTEXT);
  };

  const open = async (sessionId: string): Promise<void> => {
    const mine = ++generation;
    await release();
    try {
      await client.request(
        { serverId: DOOM_COCKPIT_SERVER_ID },
        { serviceId: DoomSessionManagementService.id, member: 'attach', args: [sessionId] },
      );
      const next = createRemoteServiceBinding({
        services: [DoomSessionService],
        transport: createClientServiceTransport(client, () => client.attachment),
      });
      const service = next.use(DoomSessionService);
      await next.ready(BACKGROUND_CONTEXT);
      if (stopped || mine !== generation) {
        await next.dispose(BACKGROUND_CONTEXT);
        return;
      }
      binding = next;
      const initial = service.state.value;
      if (initial) publish(sessionId, initial);
      unsubscribe = service.state.subscribe((state) => publish(sessionId, state));
    } catch {
      releaseProtocolTranscript(sessionId);
    }
  };

  const reconnect = async (): Promise<void> => {
    if (stopped) return;
    const started = performance.now();
    try {
      await client.reconnect();
      recordBrowserPerformance({ name: 'web.browser.protocol_ready', duration_ms: performance.now() - started });
      if (focused !== null) await open(focused);
    } catch {
      if (focused !== null) releaseProtocolTranscript(focused);
      if (!stopped) retry = setTimeout(() => void reconnect(), RECONNECT_MS);
    }
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const started = performance.now();
    try {
      await client.connect();
      recordBrowserPerformance({ name: 'web.browser.protocol_ready', duration_ms: performance.now() - started });
      if (focused !== null) await open(focused);
    } catch {
      if (focused !== null) releaseProtocolTranscript(focused);
      if (!stopped) retry = setTimeout(() => void connect(), RECONNECT_MS);
    }
  };

  client.onConnectionStateChange((change) => {
    if (stopped || change.state !== 'disconnected') return;
    if (focused !== null) releaseProtocolTranscript(focused);
    retry = setTimeout(() => void reconnect(), RECONNECT_MS);
  });

  void connect();

  return {
    focus(sessionId) {
      if (sessionId === focused) return;
      focused = sessionId;
      if (sessionId === null) void release();
      else void open(sessionId);
    },
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      void release().then(() => client.dispose());
    },
  };
}
