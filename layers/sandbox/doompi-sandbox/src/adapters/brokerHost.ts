import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { resolveBrokeredCredentials } from '../services/brokerRoutes.ts';
import { createBrokerServer } from './brokerServer.ts';

const SOCKET_DIRECTORY_PREFIX = 'doompi-broker-';
const SOCKET_FILE_NAME = 'broker.sock';
const OWNER_ONLY_DIRECTORY = 0o700;
const TOKEN_BYTES = 32;

export interface RunningBroker {
  /** Host directory holding the socket, mounted into the container. */
  socketDirectory: string;
  /** Secret the container presents instead of any real credential. */
  token: string;
  /** Pi provider names the session may reach. */
  providers: string[];
  /** Host environment variables whose values the container must not receive. */
  withheldEnv: string[];
  stop(): Promise<void>;
}

export interface StartBrokerOptions {
  environment: Readonly<Record<string, string | undefined>>;
  onDenied?: (reason: string) => void;
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

  const socketDirectory = fs.mkdtempSync(path.join(os.tmpdir(), SOCKET_DIRECTORY_PREFIX));
  fs.chmodSync(socketDirectory, OWNER_ONLY_DIRECTORY);
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const credentials = new Map(resolved.map((credential) => [credential.route.provider, credential]));
  const server = createBrokerServer({ credentials, token, onDenied: options.onDenied });

  const socketPath = path.join(socketDirectory, SOCKET_FILE_NAME);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    socketDirectory,
    token,
    providers: resolved.map((credential) => credential.route.provider),
    withheldEnv: resolved.map((credential) => credential.envName),
    stop: () => stopBroker(server, socketDirectory),
  };
}

async function stopBroker(server: http.Server, socketDirectory: string): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // An in-flight provider stream would otherwise hold the socket open past
    // the session that owns it.
    server.closeAllConnections();
  });
  fs.rmSync(socketDirectory, { recursive: true, force: true });
}
