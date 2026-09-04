import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { SessionMetadata } from '@earendil-works/pi-agent-core';
import type { ServerHost } from '@earendil-works/pi-server';
import { createUnixServer } from '@earendil-works/pi-server/unix';

/** Owner-only, matching the session socket: the filesystem is the access control. */
const SOCKET_MODE = 0o600;

export interface ProtocolSocket {
  readonly socketPath: string;
  readonly serverId: string;
  close(): Promise<void>;
}

export interface ProtocolSocketOptions<TMetadata extends SessionMetadata = SessionMetadata> {
  socketPath: string;
  service: ServerHost<TMetadata>;
  serverId?: string;
  onNotice?: (message: string) => void;
}

/** Serves a routed Pi 0.85 host over an owner-only Unix socket. */
export async function serveProtocolSocket<TMetadata extends SessionMetadata>(
  options: ProtocolSocketOptions<TMetadata>,
): Promise<ProtocolSocket> {
  await fs.rm(options.socketPath, { force: true });
  const serverId = options.serverId ?? randomUUID();
  const server = createUnixServer(options.service, {
    serverId,
    path: options.socketPath,
    mode: SOCKET_MODE,
    onError: (error) => options.onNotice?.(`protocol socket error: ${error.message}`),
  });
  await server.start();
  return {
    serverId,
    socketPath: options.socketPath,
    async close() {
      await server.close();
      await fs.rm(options.socketPath, { force: true });
    },
  };
}
