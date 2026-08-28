import { sealedSession } from './sealedSession.ts';
import { recordBrowserPerformance } from './browserTelemetry.ts';

type Frame = Record<string, unknown>;

export interface SessionSocket {
  send(frame: object): void;
  close(): void;
}

export interface SessionSocketHandlers {
  onFrame(frame: Frame): void;
  onOpen(): void;
  onClose(): void;
}

const RECONNECT_MS = 700;

export function sessionSocketUrl(location: { protocol: string; host: string }): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/api/session`;
}

/**
 * Keeps a WebSocket to the bridge open for the life of the page.
 *
 * Reconnecting is unconditional because the bridge, not the browser, decides
 * whether the session is still there; the page's job is to keep offering.
 */
export function createSessionSocket(url: string, handlers: SessionSocketHandlers): SessionSocket {
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let opened = false;
  let connectingAt = performance.now();

  const open = (): void => {
    if (stopped) return;
    connectingAt = performance.now();
    const next = new WebSocket(url);
    socket = next;

    next.addEventListener('open', () => {
      opened = true;
      recordBrowserPerformance({
        name: 'web.browser.session_socket_ready',
        duration_ms: performance.now() - connectingAt,
      });
      handlers.onOpen();
    });

    next.addEventListener('message', (event: MessageEvent<string>) => {
      if (typeof event.data !== 'string') return;
      // Opening is serialized inside the transport, so frames stay in the order
      // they were sent even though each open is asynchronous.
      void sealedSession.openText(event.data).then((text) => {
        if (text === undefined) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          handlers.onFrame(parsed as Frame);
        }
      });
    });

    next.addEventListener('close', () => {
      handlers.onClose();
      if (stopped) return;
      if (opened) recordBrowserPerformance({ name: 'web.browser.reconnect', count: 1 });
      timer = setTimeout(open, RECONNECT_MS);
    });

    next.addEventListener('error', () => next.close());
  };

  open();

  return {
    send(frame) {
      const outgoing = socket;
      if (outgoing?.readyState !== WebSocket.OPEN) return;
      // Sealing is asynchronous, so the socket is re-checked once it resolves:
      // it may have closed while the ciphertext was being produced.
      void sealedSession
        .sealText(JSON.stringify(frame))
        .then((text) => {
          if (outgoing.readyState === WebSocket.OPEN) outgoing.send(text);
        })
        .catch(() => {
          stopped = true;
          if (timer) clearTimeout(timer);
          socket?.close();
        });
    },
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    },
  };
}
