import type { PiServerListener } from '@earendil-works/pi-server';

// pi-server names these in PiServerListener's signature but does not export
// them from its root, so they are recovered from the type that does.
type ByteConnectionAcceptor = Parameters<PiServerListener['start']>[0];
type ByteConnection = Parameters<ByteConnectionAcceptor>[0];
type ByteConnectionHandler = ReturnType<ByteConnectionAcceptor>;

/** The minimum of a WebSocket this listener drives, so a test needs no real socket. */
export interface ListenerSocket {
  send(data: ArrayBufferLike | Uint8Array): void;
  close(): void;
  readonly readyState?: number;
}

const OPEN = 1;

export interface PiWebSocketListener extends PiServerListener {
  /**
   * Hands an already-upgraded socket to the server.
   *
   * The transport authenticates during the HTTP upgrade, so a socket only
   * reaches here once the request that opened it was allowed.
   */
  accept(socket: ListenerSocket): ByteConnectionHandler | undefined;
}

/**
 * Feeds PiServer the browser's connections.
 *
 * Pi ships only a Unix listener, where the file mode is the access control.
 * A browser cannot open one, so the cockpit terminates the protocol over a
 * WebSocket instead and keeps the same contract: bytes in order, closure
 * reported once, and no protocol knowledge in the transport itself.
 */
export function createPiWebSocketListener(options: { onError?: (error: Error) => void } = {}): PiWebSocketListener {
  let acceptor: ByteConnectionAcceptor | undefined;
  const open = new Set<ListenerSocket>();

  return {
    address: 'websocket',

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
      // A socket that arrives before start, or after close, has no server to
      // talk to. Closing it is the honest answer.
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
