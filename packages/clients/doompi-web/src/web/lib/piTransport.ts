import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from '@earendil-works/pi-client';

import { sealedProtocolSession } from './sealedSession';

const PROTOCOL_PATH = '/api/pi';
const MAX_PENDING_BYTES = 64 * 1024 * 1024;

/** The cockpit's protocol endpoint for this page. */
export function protocolSocketUrl(location: Location): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${PROTOCOL_PATH}`;
}

/** Ordered, bounded bytes over the cockpit's purpose-bound sealed channel. */
export function createProtocolTransport(url: string): ByteTransportFactory {
  return async (handlers: ByteTransportHandlers): Promise<ByteTransport> => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onError);
      };
      const onOpen = (): void => {
        clean();
        resolve();
      };
      const onError = (): void => {
        clean();
        socket.close();
        reject(new Error('The cockpit protocol socket failed to open'));
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
      socket.addEventListener('close', onError, { once: true });
    });

    let terminal = false;
    let incoming = Promise.resolve();
    let outgoing = Promise.resolve();
    let incomingBytes = 0;
    let outgoingBytes = 0;
    const stop = (error?: Error): void => {
      if (terminal) return;
      terminal = true;
      socket.close();
      if (error) handlers.onError(error);
      else handlers.onClose();
    };
    const failure = (error: unknown): Error =>
      error instanceof Error ? error : new Error('The sealed protocol channel failed.');
    socket.addEventListener('message', (event: MessageEvent<ArrayBuffer | Blob | string>) => {
      if (terminal) return;
      const data = event.data;
      if (typeof data === 'string') {
        stop(new Error('Expected binary protocol bytes.'));
        return;
      }
      const size = data instanceof ArrayBuffer ? data.byteLength : data.size;
      if (incomingBytes + size > MAX_PENDING_BYTES) {
        stop(new Error('Protocol receive queue exhausted.'));
        return;
      }
      incomingBytes += size;
      incoming = incoming
        .then(async () => {
          if (terminal) return;
          const buffer = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
          const plaintext = await sealedProtocolSession.openBinary(new Uint8Array(buffer));
          if (terminal) return;
          if (plaintext === undefined) throw new Error('The sealed protocol frame could not be opened.');
          handlers.onData(plaintext);
        })
        .catch((error: unknown) => stop(failure(error)))
        .finally(() => {
          incomingBytes -= size;
        });
    });
    socket.addEventListener('close', () => stop());
    socket.addEventListener('error', () => stop(new Error('The cockpit protocol socket failed')));

    return {
      async send(chunk) {
        if (terminal) throw new Error('The protocol socket is closed.');
        if (outgoingBytes + socket.bufferedAmount + chunk.byteLength > MAX_PENDING_BYTES) {
          const error = new Error('Protocol send queue exhausted.');
          stop(error);
          throw error;
        }
        outgoingBytes += chunk.byteLength;
        const next = outgoing
          .then(async () => {
            if (terminal) throw new Error('The protocol socket is closed.');
            const sealed = await sealedProtocolSession.sealBinary(chunk);
            if (terminal) throw new Error('The protocol socket is closed.');
            if (socket.bufferedAmount + sealed.byteLength > MAX_PENDING_BYTES)
              throw new Error('Protocol send queue exhausted.');
            socket.send(sealed.slice().buffer as ArrayBuffer);
          })
          .finally(() => {
            outgoingBytes -= chunk.byteLength;
          });
        // The caller receives the rejection; the queue also closes the connection.
        outgoing = next.catch((error: unknown) => stop(failure(error)));
        return next;
      },
      close() {
        stop();
      },
    };
  };
}
