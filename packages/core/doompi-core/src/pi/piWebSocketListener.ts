import type { Server, ServerListener } from '@earendil-works/pi-server';

type ByteConnection = Parameters<Server['accept']>[0];
type ByteConnectionHandler = ReturnType<Server['accept']>;
type ByteConnectionAcceptor = (connection: ByteConnection) => ByteConnectionHandler;

/** The minimum WebSocket surface needed by the Pi byte-protocol listener. */
export interface PiListenerSocket {
  send(data: ArrayBufferLike | Uint8Array): void | Promise<void>;
  close(): void;
  readonly readyState?: number;
}

const OPEN = 1;
const MAX_PENDING_BYTES = 64 * 1024 * 1024;

export interface PiWebSocketListener extends ServerListener {
  /** Hands an authenticated, already-upgraded socket to the protocol server. */
  accept(socket: PiListenerSocket): ByteConnectionHandler | undefined;
}

/** Adapts authenticated browser WebSockets to Pi 0.85 byte connections. */
export function createPiWebSocketListener(options: { onError?: (error: Error) => void } = {}): PiWebSocketListener {
  let acceptor: ByteConnectionAcceptor | undefined;
  const open = new Set<() => Promise<void>>();
  return {
    async start(accept) {
      acceptor = accept;
    },
    async close() {
      acceptor = undefined;
      await Promise.all(
        [...open].map(async (close) => {
          try {
            await close();
          } catch (error) {
            options.onError?.(error instanceof Error ? error : new Error(String(error)));
          }
        }),
      );
    },
    accept(socket) {
      if (!acceptor) {
        socket.close();
        return undefined;
      }
      let closed = false;
      let closing = false;
      let notified = false;
      let sending = Promise.resolve();
      let queuedBytes = 0;
      let handler: ByteConnectionHandler | undefined;
      const write = async (chunk: Uint8Array): Promise<void> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            socket.send(chunk),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Protocol socket write timed out.')), 15_000);
              timer.unref();
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const notify = (error?: Error): void => {
        closed = true;
        open.delete(close);
        if (notified) return;
        notified = true;
        if (error) handler?.onError(error);
        else handler?.onClose();
      };
      const close = async (finalChunk?: Uint8Array): Promise<void> => {
        if (closing || closed) return;
        closing = true;
        open.delete(close);
        try {
          await sending;
          if (!closed && finalChunk) await write(finalChunk);
        } finally {
          try {
            socket.close();
          } finally {
            notify();
          }
        }
      };
      const connection: ByteConnection = {
        get closed() {
          return closed || closing || (socket.readyState !== undefined && socket.readyState !== OPEN);
        },
        async send(chunk) {
          if (connection.closed) throw new Error('Protocol socket closed before send.');
          if (queuedBytes + chunk.byteLength > MAX_PENDING_BYTES) {
            const error = new Error('Protocol socket send queue exhausted.');
            notify(error);
            socket.close();
            throw error;
          }
          queuedBytes += chunk.byteLength;
          const next = sending
            .then(() => {
              if (closed) throw new Error('Protocol socket closed before send.');
              return write(chunk);
            })
            .finally(() => {
              queuedBytes -= chunk.byteLength;
            });
          sending = next.catch((error: unknown) => {
            notify(error instanceof Error ? error : new Error(String(error)));
            socket.close();
          });
          return next;
        },
        close,
      };
      open.add(close);
      try {
        handler = acceptor(connection);
      } catch (error) {
        open.delete(close);
        socket.close();
        throw error;
      }
      return {
        onData: (chunk) => {
          if (!closed && !closing) handler?.onData(chunk);
        },
        onClose: () => notify(),
        onError: (error) => notify(error),
      };
    },
  };
}
