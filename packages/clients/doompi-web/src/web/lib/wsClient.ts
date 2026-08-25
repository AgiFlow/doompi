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

  const open = (): void => {
    if (stopped) return;
    const next = new WebSocket(url);
    socket = next;

    next.addEventListener('open', () => handlers.onOpen());

    next.addEventListener('message', (event: MessageEvent<string>) => {
      if (typeof event.data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        handlers.onFrame(parsed as Frame);
      }
    });

    next.addEventListener('close', () => {
      handlers.onClose();
      if (stopped) return;
      timer = setTimeout(open, RECONNECT_MS);
    });

    next.addEventListener('error', () => next.close());
  };

  open();

  return {
    send(frame) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    },
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    },
  };
}
