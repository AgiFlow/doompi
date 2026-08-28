import net from 'node:net';
import { reattachDelayMs } from '../services/retryPolicy.ts';
import { createFrameDecoder, encodeFrame } from '../services/sessionFraming.ts';
import type { AttachOptions, SessionAttachment } from '../types/bridge.ts';
import { ATTACH_ERROR_TYPE, ATTACH_TYPE, ATTACHED_TYPE, bridgeStatus, type SessionFrame } from '../types/session.ts';

/** Commands held while the handshake is in flight; beyond this the oldest go. */
const PENDING_LIMIT = 64;

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Holds one authenticated attachment to a doompi-server socket.
 *
 * Reattaching is the normal path, not error handling: the server keeps the
 * agent alive across a dropped client and replays what was missed, so a
 * reloaded page recovers instead of losing the run.
 */
export function attachToSession(options: AttachOptions): SessionAttachment {
  let socket: net.Socket | undefined;
  let timer: NodeJS.Timeout | undefined;
  let attempt = 0;
  let stopped = false;
  let authenticated = false;
  const pending: SessionFrame[] = [];

  const connect = (): void => {
    if (stopped) return;
    authenticated = false;
    options.handlers.onStatus(bridgeStatus('connecting'));
    const decode = createFrameDecoder();
    const connection = net.connect(options.socketPath);
    socket = connection;
    connection.setEncoding('utf8');

    connection.on('connect', () => {
      connection.write(
        encodeFrame({ type: ATTACH_TYPE, token: options.token, ...(options.trace === undefined ? {} : options.trace) }),
      );
    });

    connection.on('data', (chunk: string) => {
      let frames: SessionFrame[];
      try {
        frames = decode(chunk);
      } catch {
        options.handlers.onStatus(bridgeStatus('closed', { reason: 'The session sent a malformed frame.' }));
        connection.destroy();
        return;
      }
      for (const frame of frames) {
        if (frame.type === ATTACHED_TYPE) {
          authenticated = true;
          attempt = 0;
          options.handlers.onStatus(
            bridgeStatus('attached', { replayed: asCount(frame.replayed), dropped: asCount(frame.dropped) }),
          );
          for (const queued of pending.splice(0)) connection.write(encodeFrame(queued));
          continue;
        }
        if (frame.type === ATTACH_ERROR_TYPE) {
          const reason = typeof frame.reason === 'string' ? frame.reason : 'The session refused this client.';
          options.handlers.onStatus(bridgeStatus('refused', { reason }));
          continue;
        }
        options.handlers.onFrame(frame);
      }
    });

    const retry = (): void => {
      if (stopped) return;
      if (socket === connection) socket = undefined;
      options.handlers.onStatus(bridgeStatus(authenticated ? 'detached' : 'connecting'));
      attempt += 1;
      timer = setTimeout(connect, reattachDelayMs(attempt));
    };

    connection.on('close', retry);
    connection.on('error', () => {
      // 'close' always follows, and it owns the retry.
    });
  };

  connect();

  return {
    send(frame) {
      if (stopped) return;
      if (!authenticated || !socket) {
        // A command that lands while the hub is (re)attaching, typically right
        // after a session restart, waits for the handshake instead of vanishing.
        pending.push(frame);
        if (pending.length > PENDING_LIMIT) pending.shift();
        return;
      }
      socket.write(encodeFrame(frame));
    },
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.destroy();
      socket = undefined;
    },
  };
}
