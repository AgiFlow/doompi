import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import { evaluateHandshake, handshakeAccepted, handshakeRejected, replayFrame } from '../services/handshake.ts';
import { createDetachedBacklog, createFrameDecoder, encodeFrame } from '../services/sessionFraming.ts';
import type { AgentProcess, SessionFrame } from '../types/session.ts';

const OWNER_ONLY_SOCKET = 0o600;
const OWNER_ONLY_UMASK = 0o177;
const DEFAULT_BACKLOG = 512;

export interface SessionSocketOptions {
  socketPath: string;
  token: string;
  agent: AgentProcess;
  /** Frames retained while no client is attached. */
  backlogLimit?: number;
  onNotice?: (message: string) => void;
}

export interface SessionSocket {
  readonly attached: boolean;
  /** Frames buffered for the next client, zero while one is attached. */
  readonly backlogged: number;
  close(): Promise<void>;
}

function sameToken(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Publishes one supervised agent on an authenticated unix socket.
 *
 * A single client holds the session at a time, and losing that client does not
 * end the run: frames buffer until someone reattaches, which is what makes a
 * dropped terminal or a reloaded browser tab recoverable rather than fatal.
 */
export function serveSessionSocket(options: SessionSocketOptions): SessionSocket {
  const backlog = createDetachedBacklog(options.backlogLimit ?? DEFAULT_BACKLOG);
  let client: net.Socket | undefined;

  options.agent.onFrame((frame) => {
    if (client) client.write(encodeFrame(frame));
    else backlog.record(frame);
  });

  const server = net.createServer((connection) => {
    connection.setEncoding('utf8');
    const decode = createFrameDecoder();
    let authenticated = false;

    connection.on('data', (chunk: string) => {
      let frames: SessionFrame[];
      try {
        frames = decode(chunk);
      } catch {
        connection.write(encodeFrame(handshakeRejected('The client sent a malformed frame.')));
        connection.destroy();
        return;
      }

      for (const frame of frames) {
        if (authenticated) {
          options.agent.send(frame);
          continue;
        }
        if (client) {
          connection.write(encodeFrame(handshakeRejected('Another client already holds this session.')));
          connection.destroy();
          return;
        }
        const outcome = evaluateHandshake(frame, options.token, sameToken);
        if (!outcome.accepted) {
          options.onNotice?.(`attach refused: ${outcome.reason}`);
          connection.write(encodeFrame(handshakeRejected(outcome.reason)));
          connection.destroy();
          return;
        }
        authenticated = true;
        client = connection;
        const drained = backlog.drain();
        connection.write(encodeFrame(handshakeAccepted(drained.frames.length, drained.dropped)));
        for (const missed of drained.frames) connection.write(encodeFrame(replayFrame(missed)));
        options.onNotice?.(`client attached, replayed ${drained.frames.length} frame(s)`);
      }
    });

    const detach = (): void => {
      if (client === connection) {
        client = undefined;
        options.onNotice?.('client detached; the session keeps running');
      }
    };
    connection.on('close', detach);
    connection.on('error', detach);
  });

  // The umask makes the mode atomic at creation; chmod alone would leave a
  // window where the socket is world-connectable.
  const previousUmask = process.umask(OWNER_ONLY_UMASK);
  try {
    server.listen(options.socketPath, () => {
      fs.chmodSync(options.socketPath, OWNER_ONLY_SOCKET);
    });
  } finally {
    process.umask(previousUmask);
  }

  return {
    get attached(): boolean {
      return client !== undefined;
    },
    get backlogged(): number {
      return backlog.held;
    },
    close: () =>
      new Promise<void>((resolve) => {
        client?.destroy();
        server.close(() => resolve());
        fs.rmSync(options.socketPath, { force: true });
      }),
  };
}
