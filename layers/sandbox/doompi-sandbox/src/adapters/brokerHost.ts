import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { resolveBrokeredCredentials } from '../services/brokerRoutes.ts';
import type { BrokerEndpoint } from '../types/sandboxHarness.ts';
import { createBrokerServer } from './brokerServer.ts';

const SOCKET_DIRECTORY_PREFIX = 'doompi-broker-';
const SOCKET_FILE_NAME = 'broker.sock';
const OWNER_ONLY_DIRECTORY = 0o700;
const TOKEN_BYTES = 32;
const LOOPBACK = '127.0.0.1';
const LINUX_PLATFORM = 'linux';
const EPHEMERAL_PORT = 0;

export interface RunningBroker {
  /** How a container reaches this broker. */
  endpoint: BrokerEndpoint;
  /** Secret the container presents instead of any real credential. */
  token: string;
  /** Pi provider names the session may reach. */
  providers: string[];
  /** Host environment variables whose value the container receives as the token. */
  withheldEnv: string[];
  stop(): Promise<void>;
}

export interface StartBrokerOptions {
  environment: Readonly<Record<string, string | undefined>>;
  onDenied?: (reason: string) => void;
  /** Seam for tests; defaults to this host's platform. */
  platform?: string;
  /**
   * Fixed directory to hold the socket instead of a fresh temporary one.
   *
   * A reused container keeps the mounts it was created with, so a dev
   * container has to find the socket at the same path on every launch.
   */
  socketDirectory?: string;
  /** Forces the loopback transport even where a socket would work. */
  forceLoopback?: boolean;
}

/**
 * Starts the host-side provider broker for one sandboxed session.
 *
 * Answers undefined when the host holds no brokerable credential, which keeps
 * a session that authenticates some other way on the unbrokered path instead
 * of failing it.
 */
export async function startBroker(options: StartBrokerOptions): Promise<RunningBroker | undefined> {
  const resolved = resolveBrokeredCredentials(options.environment);
  if (resolved.length === 0) return undefined;

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const credentials = new Map(resolved.map((credential) => [credential.route.provider, credential]));
  const server = createBrokerServer({ credentials, token, onDenied: options.onDenied });
  const platform = options.platform ?? process.platform;

  const useSocket = platform === LINUX_PLATFORM && options.forceLoopback !== true;
  const { endpoint, dispose } = useSocket
    ? await listenOnSocket(server, options.socketDirectory)
    : await listenOnLoopback(server);

  return {
    endpoint,
    token,
    providers: resolved.map((credential) => credential.route.provider),
    withheldEnv: resolved.map((credential) => credential.envName),
    stop: () => stopBroker(server, dispose),
  };
}

/**
 * Native Linux shares a kernel with the container, so a bind-mounted socket
 * needs no port and is reachable as an ordinary file.
 */
async function listenOnSocket(
  server: http.Server,
  fixedDirectory?: string,
): Promise<{ endpoint: BrokerEndpoint; dispose: () => void }> {
  const socketDirectory = fixedDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), SOCKET_DIRECTORY_PREFIX));
  fs.mkdirSync(socketDirectory, { recursive: true });
  fs.chmodSync(socketDirectory, OWNER_ONLY_DIRECTORY);
  const socketPath = path.join(socketDirectory, SOCKET_FILE_NAME);
  // A previous session that died without closing leaves the node behind, and
  // bind fails on an existing path.
  fs.rmSync(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    endpoint: { transport: 'unix', socketDirectory },
    // A fixed directory outlives the session that borrowed it.
    dispose: () =>
      fixedDirectory
        ? fs.rmSync(socketPath, { force: true })
        : fs.rmSync(socketDirectory, { recursive: true, force: true }),
  };
}

/**
 * Everywhere else the container runs in its own virtual machine, which cannot
 * connect to a host unix socket even when the file is shared through: the
 * connect fails with ENOTSUP. Loopback keeps the broker off the network while
 * still being reachable through the engine's host gateway, and the session
 * token is what stops another local process from using it.
 */
async function listenOnLoopback(server: http.Server): Promise<{ endpoint: BrokerEndpoint; dispose: () => void }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(EPHEMERAL_PORT, LOOPBACK, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('The broker did not report a listening port.');
  return { endpoint: { transport: 'tcp', port: address.port }, dispose: () => undefined };
}

async function stopBroker(server: http.Server, dispose: () => void): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // An in-flight provider stream would otherwise hold the listener open past
    // the session that owns it.
    server.closeAllConnections();
  });
  dispose();
}
