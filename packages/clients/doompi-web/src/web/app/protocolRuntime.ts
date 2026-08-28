import { PiClient } from '@earendil-works/pi-client';
import { RemoteSession } from '@earendil-works/pi-coding-agent/client';
import { createProtocolTransport, protocolSocketUrl } from '../lib/piTransport.ts';
import { recordBrowserPerformance } from '../lib/browserTelemetry.ts';
import { toTimelineEntries } from '../lib/protocolTimeline.ts';
import { applyProtocolTranscript, releaseProtocolTranscript } from '../stores/sessionStore.ts';

/** How long to wait before dialling again after the protocol socket drops. */
const RECONNECT_MS = 700;

export interface ProtocolRuntime {
  /** Points the runtime at the session the page is showing, or at none. */
  focus(sessionId: string | null): void;
  stop(): void;
}

/**
 * Runs Pi's own client for whichever session the page is showing.
 *
 * The transcript is the protocol's to state and the cockpit's only to draw, so
 * this holds one session open and republishes what the server says. Everything
 * DoomPi owns, dialogs and modes and plugin channels, stays on the hub socket
 * beside it, because the protocol has no shape for any of it.
 */
export function startProtocolRuntime(location: Location = window.location): ProtocolRuntime {
  const client = new PiClient({ transportFactory: createProtocolTransport(protocolSocketUrl(location)) });
  let session: RemoteSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let focused: string | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  /** Guards against a slow open landing after the page moved on. */
  let generation = 0;

  const release = async (): Promise<void> => {
    unsubscribe?.();
    unsubscribe = undefined;
    const previous = session;
    session = undefined;
    if (previous?.id) releaseProtocolTranscript(previous.id);
    await previous?.dispose().catch(() => undefined);
  };

  const publish = (sessionId: string, remote: RemoteSession): void => {
    const state = remote.state;
    if (!state.snapshot) return;
    applyProtocolTranscript(sessionId, toTimelineEntries(state.transcript), state.snapshot.phase !== 'idle');
  };

  const open = async (sessionId: string): Promise<void> => {
    const mine = ++generation;
    await release();
    try {
      const remote = await RemoteSession.open(client, sessionId);
      if (stopped || mine !== generation) {
        await remote.dispose().catch(() => undefined);
        return;
      }
      session = remote;
      unsubscribe = remote.subscribe(() => publish(sessionId, remote));
      publish(sessionId, remote);
    } catch {
      releaseProtocolTranscript(sessionId);
      // A session the hub has not caught up with yet is normal right after a
      // page creates one; legacy frames remain the realtime fallback.
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
      void release().then(() => client.dispose().catch(() => undefined));
    },
  };
}
