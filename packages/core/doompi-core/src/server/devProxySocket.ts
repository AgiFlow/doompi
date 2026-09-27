import { WebSocket, type RawData } from 'ws';

import { loopbackFor } from '../services/loopbackAddress';

/**
 * A WebSocket carried between a paired device and a local dev server.
 *
 * This is what carries hot module reload. Vite negotiates the `vite-hmr` subprotocol, so the
 * handshake's protocol list is forwarded rather than dropped; without it the dev client connects
 * and then gives up. The tunnel listener has already authorized the handshake, so this only
 * relays frames.
 */

/** Sent when the upstream never came up, or died in a way with no code to relay. */
const INTERNAL_ERROR = 1011;
const NORMAL_CLOSURE = 1000;
/** Reserved codes a peer may observe but no endpoint may transmit. */
const UNSENDABLE_CLOSE_CODES = new Set([1005, 1006, 1015]);
const MAX_CLOSE_REASON = 120;
/** Frames held while the upstream connects; a dev client that speaks first must not lose them. */
const MAX_PENDING_BYTES = 1024 * 1024;

export interface DevProxySocketInput {
  port: number;
  /** Path and query exactly as the browser sent them, prefix included. */
  upstreamPath: string;
  /** The browser's requested subprotocols, forwarded so HMR can negotiate. */
  protocols: string | undefined;
  onNotice?: (message: string) => void;
}

/** A code the upstream reported that this endpoint is actually allowed to send on. */
function sendableCode(code: number): number {
  return code === 0 || UNSENDABLE_CLOSE_CODES.has(code) ? NORMAL_CLOSURE : code;
}

function frameBytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(new Uint8Array(data));
}

/** Relays one accepted browser socket to the dev server on the target's port until either side closes. */
export function relayDevProxySocket(client: WebSocket, input: DevProxySocketInput): void {
  let upstream: WebSocket | undefined;
  let pending: { data: Buffer; binary: boolean }[] = [];
  let pendingBytes = 0;
  let closed = false;

  const closeBoth = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    pending = [];
    if (client.readyState === WebSocket.OPEN) client.close(code, reason.slice(0, MAX_CLOSE_REASON));
    upstream?.close();
  };

  client.on('message', (data: RawData, binary: boolean) => {
    if (closed) return;
    const bytes = frameBytes(data);
    if (upstream?.readyState === WebSocket.OPEN) {
      upstream.send(binary ? bytes : bytes.toString('utf8'));
      return;
    }
    pendingBytes += bytes.byteLength;
    if (pendingBytes > MAX_PENDING_BYTES) closeBoth(INTERNAL_ERROR, 'dev server socket did not open');
    else pending.push({ data: bytes, binary });
  });
  client.on('close', () => closeBoth(NORMAL_CLOSURE, ''));
  client.on('error', () => closeBoth(INTERNAL_ERROR, 'browser socket failed'));

  const protocols = input.protocols
    ?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  // Resolving the loopback family is a round trip, so the browser socket is already open by the
  // time the upstream is dialled. That is the window `pending` covers.
  void loopbackFor(input.port).then((host) => {
    if (closed) return;
    const authority = host.includes(':') ? `[${host}]` : host;
    const target = `ws://${authority}:${String(input.port)}${input.upstreamPath}`;
    const socket =
      protocols === undefined || protocols.length === 0 ? new WebSocket(target) : new WebSocket(target, protocols);
    upstream = socket;
    socket.on('open', () => {
      for (const frame of pending) socket.send(frame.binary ? frame.data : frame.data.toString('utf8'));
      pending = [];
      pendingBytes = 0;
    });
    socket.on('message', (data: RawData, binary: boolean) => {
      if (closed || client.readyState !== WebSocket.OPEN) return;
      const bytes = frameBytes(data);
      client.send(binary ? bytes : bytes.toString('utf8'));
    });
    socket.on('close', (code: number, reason: Buffer) => closeBoth(sendableCode(code), reason.toString()));
    socket.on('error', (error: Error) => {
      input.onNotice?.(`dev proxy socket to port ${String(input.port)} failed: ${error.message}`);
      closeBoth(INTERNAL_ERROR, 'dev server socket failed');
    });
  });
}
