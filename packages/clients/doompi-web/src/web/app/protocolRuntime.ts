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
import { createProtocolTimeline, toQueuedEntries } from '../lib/protocolTimeline.ts';
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
  let boundSessionId: string | null = null;
  let focused: string | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let generation = 0;

  const schedule = (action: () => Promise<void>): void => {
    if (retry) clearTimeout(retry);
    if (!stopped)
      retry = setTimeout(() => {
        retry = undefined;
        void action();
      }, RECONNECT_MS);
  };

  const release = async (): Promise<void> => {
    unsubscribe?.();
    unsubscribe = undefined;
    const previous = binding;
    binding = undefined;
    if (boundSessionId !== null) releaseProtocolTranscript(boundSessionId);
    boundSessionId = null;
    // A lost attachment cannot accept an unsubscribe. Local ownership has
    // already been released, so recovery must continue even if disposal fails.
    if (previous) await previous.dispose(BACKGROUND_CONTEXT).catch(() => undefined);
  };

  const open = async (sessionId: string): Promise<void> => {
    const mine = ++generation;
    let next: RemoteServiceBinding | undefined;
    try {
      await release();
      if (stopped || mine !== generation || !client.connected) return;
      await client.request(
        { serverId: DOOM_COCKPIT_SERVER_ID },
        { serviceId: DoomSessionManagementService.id, member: 'attach', args: [sessionId] },
      );
      if (stopped || mine !== generation) return;
      next = createRemoteServiceBinding({
        services: [DoomSessionService],
        transport: createClientServiceTransport(client, () => client.attachment),
      });
      const service = next.use(DoomSessionService);
      await next.ready(BACKGROUND_CONTEXT);
      if (stopped || mine !== generation) return;
      binding = next;
      next = undefined;
      boundSessionId = sessionId;
      const timeline = createProtocolTimeline();
      const publish = (state: SessionServiceState): void => {
        applyProtocolTranscript(sessionId, timeline(state), state.snapshot.phase !== 'idle');
        applyProtocolQueue(sessionId, toQueuedEntries(state.snapshot.queuedSteer));
      };
      const initial = service.state.value;
      if (initial) publish(initial);
      unsubscribe = service.state.subscribe(publish);
    } catch {
      if (stopped || mine !== generation) return;
      releaseProtocolTranscript(sessionId);
      // A replacement process may not have published its registry record yet.
      if (client.connected)
        schedule(async () => {
          if (focused !== null) await open(focused);
        });
    } finally {
      // Failed or superseded openings never become the active binding.
      await next?.dispose(BACKGROUND_CONTEXT).catch(() => undefined);
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
      schedule(connect);
    }
  };

  client.onConnectionStateChange((change) => {
    if (stopped || change.state !== 'disconnected') return;
    generation += 1;
    if (focused !== null) releaseProtocolTranscript(focused);
    void release();
    schedule(connect);
  });

  client.onAttachmentChange((attachment) => {
    // A session process can restart while the browser-to-hub socket stays open.
    if (stopped || attachment !== undefined || !client.connected) return;
    generation += 1;
    void release();
    if (focused !== null)
      schedule(async () => {
        if (focused !== null) await open(focused);
      });
  });

  void connect();

  return {
    focus(sessionId) {
      if (sessionId === focused) return;
      focused = sessionId;
      if (retry && client.connected) {
        clearTimeout(retry);
        retry = undefined;
      }
      if (sessionId === null) {
        generation += 1;
        void release();
      } else if (client.connected) void open(sessionId);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      generation += 1;
      if (retry) clearTimeout(retry);
      void release().then(() => client.dispose());
    },
  };
}
