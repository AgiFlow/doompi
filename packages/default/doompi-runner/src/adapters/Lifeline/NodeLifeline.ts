import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { IRunnerPaths } from '../../services/RunnerPaths/types';
import { LIFELINE_ENV } from './client.ts';
import type { ILifeline } from '../../types/lifeline';

const SOCKET_NAME = 'lifeline.sock';
/** Unix socket paths are capped at 104 bytes, so a long agent directory falls back to the temp dir. */
const SOCKET_PATH_LIMIT = 100;
const SOCKET_HASH_LENGTH = 12;
const SOCKET_MODE = 0o600;

export class NodeLifeline implements ILifeline {
  private server: net.Server | undefined;
  private target: string | undefined;
  /** Closing a server stops it accepting; only the connections carry the death signal. */
  private readonly connections = new Set<net.Socket>();

  constructor(private readonly paths: IRunnerPaths) {}

  async arm(sessionId: string): Promise<string | undefined> {
    if (this.target) return this.target;
    try {
      this.paths.ensureDirectories(sessionId);
      const target = this.socketPath(sessionId);
      // A socket left behind by a SIGKILLed predecessor refuses connections, never accepts them.
      fs.rmSync(target, { force: true });
      const server = net.createServer((connection) => {
        // Runners need only the close edge, so their liveness and their data are equally irrelevant.
        connection.unref();
        connection.resume();
        this.connections.add(connection);
        connection.on('close', () => this.connections.delete(connection));
      });
      await listen(server, target);
      fs.chmodSync(target, SOCKET_MODE);
      // The lifeline must never be the reason pi stays alive.
      server.unref();
      this.server = server;
      this.target = target;
      process.env[LIFELINE_ENV] = target;
      return target;
    } catch (error) {
      // Runners stay unwatched rather than unlaunchable, so a session without a
      // lifeline degrades to running them unsupervised instead of failing.
      process.emitWarning(`Could not arm the doom-runner lifeline: ${String(error)}`);
      return undefined;
    }
  }

  path(): string | undefined {
    return this.target;
  }

  dispose(): void {
    // Dropping the connections is what a runner sees, and it is the whole point
    // of disposing: closing the server alone would leave every runner waiting.
    for (const connection of this.connections) connection.destroy();
    this.connections.clear();
    if (this.server) {
      try {
        this.server.close();
      } catch (error) {
        process.emitWarning(`Could not close the doom-runner lifeline: ${String(error)}`);
      }
      this.server = undefined;
    }
    if (this.target) {
      try {
        fs.rmSync(this.target, { force: true });
      } catch (error) {
        process.emitWarning(`Could not remove the doom-runner lifeline: ${String(error)}`);
      }
      this.target = undefined;
    }
    if (process.env[LIFELINE_ENV]) delete process.env[LIFELINE_ENV];
  }

  /** Keeps the socket beside the session it belongs to unless that path is too long to bind. */
  private socketPath(sessionId: string): string {
    const preferred = path.join(this.paths.stateDirectory(sessionId), SOCKET_NAME);
    if (Buffer.byteLength(preferred) <= SOCKET_PATH_LIMIT) return preferred;
    const hash = createHash('sha256').update(preferred).digest('hex').slice(0, SOCKET_HASH_LENGTH);
    return path.join(os.tmpdir(), `doom-runner-${hash}.sock`);
  }
}

/** Binding must complete before the first runner launches, so arming waits for it. */
function listen(server: net.Server, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(target, () => {
      server.removeListener('error', reject);
      // Later errors would otherwise reach the process as unhandled.
      server.on('error', (error: Error) => process.emitWarning(`doom-runner lifeline failed: ${error.message}`));
      resolve();
    });
  });
}
