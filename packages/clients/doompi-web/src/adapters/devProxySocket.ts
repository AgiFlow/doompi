import { WebSocket as UpstreamSocket } from 'ws';
import type { WSContext, WSMessageReceive } from 'hono/ws';
import { loopbackFor } from './loopbackAddress.ts';

/**
 * A WebSocket carried between the browser and a local dev server.
 *
 * nginx pipes the TCP stream once the handshake is done and never learns what
 * a frame is. This cannot: `@hono/node-ws` terminates the socket so that the
 * upgrade travels through the ordinary route table, which is what keeps
 * `guard.middleware` in front of it. Registering a bypass would have been
 * fewer lines and would have moved a proxied path outside the one check every
 * other route gets, so the frames are relayed instead.
 *
 * This is what carries hot module reload. Vite negotiates the `vite-hmr`
 * subprotocol, so the handshake's protocol list is forwarded rather than
 * dropped; without it the dev client connects and then gives up.
 */

/** Sent when the upstream never came up, or died in a way with no code to relay. */
const INTERNAL_ERROR = 1011;
const NORMAL_CLOSURE = 1000;
/** Reserved codes a peer may observe but no endpoint may transmit. */
const UNSENDABLE_CLOSE_CODES = new Set([1005, 1006, 1015]);

export interface DevProxySocketInput {
  port: number;
  /** Path and query exactly as the browser sent them, prefix included. */
  upstreamPath: string;
  /** The browser's requested subprotocols, forwarded so HMR can negotiate. */
  protocols: string | undefined;
}

export interface DevProxySocketHandlers {
  onOpen: (event: Event, ws: WSContext) => void;
  onMessage: (event: MessageEvent<WSMessageReceive>, ws: WSContext) => void;
  onClose: () => void;
  onError: () => void;
}

/** A code the upstream reported that this endpoint is actually allowed to send on. */
function sendableCode(code: number): number {
  if (code === 0 || UNSENDABLE_CLOSE_CODES.has(code)) return NORMAL_CLOSURE;
  return code;
}

/** The three shapes `ws` delivers a frame in, reduced to the one this relay reads. */
function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(new Uint8Array(data));
}

function toFrame(data: WSMessageReceive): string | Uint8Array {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array();
}

export function createDevProxySocket(input: DevProxySocketInput): DevProxySocketHandlers {
  let upstream: UpstreamSocket | undefined;
  // Frames the browser sent before the upstream finished connecting. A dev
  // client that speaks first would otherwise lose its opening message, and
  // Vite's does exactly that.
  let pending: (string | Uint8Array)[] = [];
  let closed = false;

  const flush = (): void => {
    if (upstream === undefined || upstream.readyState !== UpstreamSocket.OPEN) return;
    for (const frame of pending) upstream.send(frame);
    pending = [];
  };

  return {
    onOpen(_event, ws) {
      const protocols = input.protocols
        ?.split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '');
      // Resolving the loopback family is a round trip, so the browser's socket
      // is already open by the time the upstream one is dialled. That is the
      // window `pending` exists to cover.
      void loopbackFor(input.port).then((host) => {
        if (closed) return;
        const authority = host.includes(':') ? `[${host}]` : host;
        const target = `ws://${authority}:${String(input.port)}${input.upstreamPath}`;
        upstream =
          protocols === undefined || protocols.length === 0
            ? new UpstreamSocket(target)
            : new UpstreamSocket(target, protocols);

        upstream.on('open', flush);
        upstream.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
          if (closed) return;
          // Normalized before either branch reads it. `ws` hands back a Buffer, a
          // fragment array, or an ArrayBuffer depending on how the frame arrived,
          // and calling toString on the last of those yields '[object ArrayBuffer]'
          // rather than the text the dev client sent.
          const bytes = toBuffer(data);
          ws.send(isBinary ? new Uint8Array(bytes) : bytes.toString('utf8'));
        });
        upstream.on('close', (code: number, reason: Buffer) => {
          if (closed) return;
          closed = true;
          ws.close(sendableCode(code), reason.toString().slice(0, 120));
        });
        upstream.on('error', () => {
          if (closed) return;
          closed = true;
          ws.close(INTERNAL_ERROR, 'dev server socket failed');
        });
      });
    },

    onMessage(event, _ws) {
      const frame = toFrame(event.data);
      if (upstream?.readyState === UpstreamSocket.OPEN) {
        upstream.send(frame);
        return;
      }
      pending.push(frame);
    },

    onClose() {
      closed = true;
      pending = [];
      upstream?.close();
    },

    onError() {
      closed = true;
      pending = [];
      upstream?.close();
    },
  };
}
