import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from '@earendil-works/pi-client';

const PROTOCOL_PATH = '/api/pi';
const SECURE_PAGE = 'https:';
const SECURE_SOCKET = 'wss:';
const PLAIN_SOCKET = 'ws:';

/** The cockpit's protocol endpoint for this page. */
export function protocolSocketUrl(location: Location): string {
  const scheme = location.protocol === SECURE_PAGE ? SECURE_SOCKET : PLAIN_SOCKET;
  return `${scheme}//${location.host}${PROTOCOL_PATH}`;
}

/**
 * Carries Pi's protocol to the browser.
 *
 * Pi ships a Unix transport, which a page cannot open, but the client only
 * asks for ordered bytes and a closure signal. A WebSocket in binary mode is
 * exactly that, so the page runs the same client the terminal would.
 */
export function createProtocolTransport(url: string): ByteTransportFactory {
  return async (handlers: ByteTransportHandlers): Promise<ByteTransport> => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        socket.removeEventListener('error', onError);
        resolve();
      };
      const onError = (): void => {
        socket.removeEventListener('open', onOpen);
        reject(new Error('The cockpit protocol socket failed to open'));
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });

    socket.addEventListener('message', (event: MessageEvent<ArrayBuffer | Blob | string>) => {
      const data = event.data;
      // A text frame is not protocol traffic; the codec would reject it, so it
      // is dropped rather than handed on as bytes it never produced.
      if (typeof data === 'string') return;
      if (data instanceof ArrayBuffer) handlers.onData(new Uint8Array(data));
      else void data.arrayBuffer().then((buffer) => handlers.onData(new Uint8Array(buffer)));
    });
    socket.addEventListener('close', () => handlers.onClose());
    socket.addEventListener('error', () => handlers.onError(new Error('The cockpit protocol socket failed')));

    return {
      async send(chunk) {
        // Copied into a plain ArrayBuffer: the protocol codec may hand back a
        // view onto a shared buffer, which send() will not take.
        socket.send(chunk.slice().buffer as ArrayBuffer);
      },
      close() {
        socket.close();
      },
    };
  };
}
