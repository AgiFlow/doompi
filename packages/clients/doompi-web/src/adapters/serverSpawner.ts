import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DoomTraceContext } from '@agimon-ai/doompi-telemetry';
import { sessionRecordPath } from '../services/registryStore.ts';
import { type BundledServerLaunch, defaultServerLaunch } from './bundledServer.ts';

/** Names the server in messages; the resolved command is a node path nobody would recognise. */
const SERVER_LABEL = 'doompi-server';
const SPAWNED_SEGMENT = 'spawned';
const SOCKET_FILE = 's.sock';
const TOKEN_FILE = 'token';
const LOG_FILE = 'server.log';
const DIR_NAME_PREFIX_LENGTH = 8;
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;
const TOKEN_BYTES = 32;
// macOS caps sun_path around 104 bytes; failing here beats a cryptic bind error.
const MAX_SOCKET_PATH = 103;
const RECORD_WAIT_MS = 10_000;
const RECORD_POLL_MS = 100;
const LOG_TAIL_CHARS = 400;

export type SpawnOutcome =
  | { ok: true; sessionId: string }
  | { ok: false; code: 'invalid_request' | 'spawn_failed'; error: string };

export interface SpawnSessionInput {
  cwd: string;
  name?: string;
  /**
   * The id the replacement must keep, for a restart. Pi resumes the session
   * under it, so the transcript and everything keyed by the id survive the
   * server going away and coming back. Absent means a new session.
   */
  sessionId?: string;
  /**
   * The directory the replacement reuses, for a restart. Without it a restart
   * would pick a fresh directory each time, and since the socket path is
   * capped near 104 bytes, a handful of restarts would run the session out of
   * room. The previous server has exited, so its socket is gone.
   */
  sessionDir?: string;
  trace?: DoomTraceContext;
}

/** Launches doompi-server processes for sessions created from the page. */
export interface SessionSpawner {
  spawn(input: SpawnSessionInput): Promise<SpawnOutcome>;
}

export interface ServerSpawnerOptions {
  registryDir: string;
  /** Overridable so tests can stand in a fake server; defaults to the installation's own doompi-server. */
  command?: string;
  onNotice?: (message: string) => void;
}

function logTail(logPath: string): string {
  try {
    return fs.readFileSync(logPath, 'utf8').slice(-LOG_TAIL_CHARS).trim();
  } catch {
    return '';
  }
}

/**
 * Creates sessions the way a terminal would: by starting a doompi-server.
 *
 * The spawned server is detached and owns its own lifetime; it registers
 * itself like any other, which is why success is defined as "its record
 * appeared", not as anything about the child process. The hub stopping later
 * does not take created sessions down with it.
 *
 * Without an explicit command the server comes from this installation rather
 * than from PATH, so the cockpit needs no flag to launch the build it belongs
 * to. The resolution happens per session because it reads the session's own
 * working directory.
 */
export function createServerSpawner(options: ServerSpawnerOptions): SessionSpawner {
  return {
    spawn(input) {
      let stats: fs.Stats;
      try {
        stats = fs.statSync(input.cwd);
      } catch {
        return Promise.resolve({ ok: false, code: 'invalid_request', error: `No such directory: ${input.cwd}` });
      }
      if (!path.isAbsolute(input.cwd) || !stats.isDirectory()) {
        return Promise.resolve({
          ok: false,
          code: 'invalid_request',
          error: `The working directory must be an absolute path to a directory, received "${input.cwd}".`,
        });
      }

      // Resolved before anything is written, so a broken installation fails
      // without leaving a session directory nobody will ever use.
      let launch: BundledServerLaunch;
      try {
        launch = options.command
          ? { command: options.command, args: [], environment: process.env }
          : defaultServerLaunch(input.cwd, process.env);
      } catch (error) {
        return Promise.resolve({
          ok: false,
          code: 'spawn_failed',
          error: `Could not locate ${SERVER_LABEL}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const command = options.command ?? SERVER_LABEL;

      const sessionId = input.sessionId ?? crypto.randomUUID();
      // The directory borrows only a prefix of the id: sun_path is capped
      // around 104 bytes and every byte of the session dir counts against it.
      const spawnedRoot = path.join(options.registryDir, SPAWNED_SEGMENT);
      const reusedDir = input.sessionDir;
      let dirName = sessionId.slice(0, DIR_NAME_PREFIX_LENGTH);
      while (
        reusedDir === undefined &&
        fs.existsSync(path.join(spawnedRoot, dirName)) &&
        dirName.length < sessionId.length
      ) {
        dirName = sessionId.slice(0, dirName.length + DIR_NAME_PREFIX_LENGTH);
      }
      const sessionDir = reusedDir ?? path.join(spawnedRoot, dirName);
      const socketPath = path.join(sessionDir, SOCKET_FILE);
      if (socketPath.length > MAX_SOCKET_PATH) {
        return Promise.resolve({
          ok: false,
          code: 'spawn_failed',
          error: `The socket path would exceed the unix limit (${socketPath.length} > ${MAX_SOCKET_PATH}); use a shorter --registry-dir.`,
        });
      }
      const tokenFile = path.join(sessionDir, TOKEN_FILE);
      const logPath = path.join(sessionDir, LOG_FILE);
      fs.mkdirSync(sessionDir, { recursive: true, mode: OWNER_ONLY_DIR });
      fs.writeFileSync(tokenFile, crypto.randomBytes(TOKEN_BYTES).toString('hex'), { mode: OWNER_ONLY_FILE });

      const log = fs.openSync(logPath, 'a', OWNER_ONLY_FILE);
      const args = [
        '--listen',
        socketPath,
        '--auth-token-file',
        tokenFile,
        '--session-id',
        sessionId,
        '--name',
        input.name ?? 'untitled',
        '--registry-dir',
        options.registryDir,
      ];
      const environment = { ...launch.environment };
      delete environment.DOOMPI_TRACEPARENT;
      if (/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/.test(input.trace?.traceparent ?? '')) {
        environment.DOOMPI_TRACEPARENT = input.trace?.traceparent;
      }
      const child = spawn(launch.command, [...launch.args, ...args], {
        cwd: input.cwd,
        detached: true,
        stdio: ['ignore', log, log],
        env: environment,
      });
      fs.closeSync(log);

      return new Promise((resolve) => {
        let settled = false;
        const finish = (outcome: SpawnOutcome): void => {
          if (settled) return;
          settled = true;
          clearInterval(pollTimer);
          clearTimeout(deadline);
          if (outcome.ok) options.onNotice?.(`created session ${sessionId} in ${input.cwd}`);
          resolve(outcome);
        };

        child.once('error', (error) =>
          finish({ ok: false, code: 'spawn_failed', error: `Could not start ${command}: ${error.message}` }),
        );
        child.once('exit', (code) => {
          const tail = logTail(logPath);
          finish({
            ok: false,
            code: 'spawn_failed',
            error: `${command} exited with code ${code ?? 'unknown'} before registering.${tail ? ` Log: ${tail}` : ''}`,
          });
        });
        child.unref();

        const recordFile = sessionRecordPath(options.registryDir, sessionId);
        const pollTimer = setInterval(() => {
          if (fs.existsSync(recordFile)) finish({ ok: true, sessionId });
        }, RECORD_POLL_MS);
        const deadline = setTimeout(() => {
          const tail = logTail(logPath);
          finish({
            ok: false,
            code: 'spawn_failed',
            error: `${command} did not register within ${RECORD_WAIT_MS / 1000}s.${tail ? ` Log: ${tail}` : ''}`,
          });
        }, RECORD_WAIT_MS);
      });
    },
  };
}
