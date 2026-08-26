import fs from 'node:fs/promises';
import type { PiServerService } from '@earendil-works/pi-server';
import { createUnixServer } from '@earendil-works/pi-server/unix';

/** Owner-only, matching the session socket: the filesystem is the access control. */
const SOCKET_MODE = 0o600;

export interface ProtocolSocket {
  readonly socketPath: string;
  close(): Promise<void>;
}

export interface ProtocolSocketOptions {
  socketPath: string;
  service: PiServerService;
  onNotice?: (message: string) => void;
}

/**
 * Serves this session over Pi's own protocol.
 *
 * The transport authenticates before any protocol byte is exchanged, which for
 * a Unix socket means the 0600 mode rather than a token: an argument vector is
 * readable by any local process, and the socket's permissions are not.
 */
export async function serveProtocolSocket(options: ProtocolSocketOptions): Promise<ProtocolSocket> {
  await fs.rm(options.socketPath, { force: true });
  const server = createUnixServer(options.service, {
    path: options.socketPath,
    mode: SOCKET_MODE,
    onError: (error) => options.onNotice?.(`protocol socket error: ${error.message}`),
  });
  await server.start();
  return {
    socketPath: options.socketPath,
    async close() {
      await server.close();
      await fs.rm(options.socketPath, { force: true });
    },
  };
}
