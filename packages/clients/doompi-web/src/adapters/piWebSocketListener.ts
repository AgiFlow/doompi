import type { Server, ServerListener } from '@earendil-works/pi-server';

type ByteConnection = Parameters<Server['accept']>[0];
type ByteConnectionHandler = ReturnType<Server['accept']>;
type ByteConnectionAcceptor = (connection: ByteConnection) => ByteConnectionHandler;

/** The minimum of a WebSocket this listener drives, so a test needs no real socket. */
export interface ListenerSocket {
  send(data: ArrayBufferLike | Uint8Array): void;
  close(): void;
  readonly readyState?: number;
}

const OPEN = 1;

export interface PiWebSocketListener extends ServerListener {
  /** Hands an authenticated, already-upgraded socket to the protocol server. */
  accept(socket: ListenerSocket): ByteConnectionHandler | undefined;
}

/** Adapts authenticated browser WebSockets to Pi 0.85 byte connections. */
export function createPiWebSocketListener(options: { onError?: (error: Error) => void } = {}): PiWebSocketListener {
  let acceptor: ByteConnectionAcceptor | undefined;
  const open = new Set<ListenerSocket>();

  return {
    async start(accept) {
      acceptor = accept;
    },
    async close() {
      acceptor = undefined;
      for (const socket of open) {
        try {
          socket.close();
        } catch (error) {
          options.onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      }
      open.clear();
    },
    accept(socket) {
      if (!acceptor) {
        socket.close();
        return undefined;
      }
      open.add(socket);
      let closed = false;
      const connection: ByteConnection = {
        get closed() {
          return closed || (socket.readyState !== undefined && socket.readyState !== OPEN);
        },
        async send(chunk) {
          socket.send(chunk);
        },
        close(finalChunk) {
          if (finalChunk) socket.send(finalChunk);
          closed = true;
          open.delete(socket);
          socket.close();
        },
      };
      const handler = acceptor(connection);
      return {
        onData: (chunk) => handler.onData(chunk),
        onClose: () => {
          closed = true;
          open.delete(socket);
          handler.onClose();
        },
        onError: (error) => {
          closed = true;
          open.delete(socket);
          handler.onError(error);
        },
      };
    },
  };
}
