import { type ChildProcess, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import spawn from 'cross-spawn';
import { readJson, writeJson } from '../serialization/json';

/**
 * Child process and cross-repository locking primitives.
 *
 * Shared by every compatibility provider and by the Pi launch command, so that
 * signal forwarding behaves the same however the harness starts a child.
 */

const FORWARDED_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];
const SIGNAL_EXIT_CODE_OFFSET = 128;
const UNKNOWN_SIGNAL_EXIT_CODE = 1;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 30_000;
const FILE_EXISTS_ERROR = 'EEXIST';
const FILE_NOT_FOUND_ERROR = 'ENOENT';
const PROCESS_NOT_FOUND_ERROR = 'ESRCH';
const LOCK_OWNER_FILENAME = 'owner.json';

/** Runs a command and returns its trimmed stdout, throwing on a non-zero exit. */
export function runCaptured(command: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: environment });
  if (result.error) throw result.error;
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? 1}`);
  }
  return result.stdout.trim();
}

/** Runs a command with inherited stdio, throwing on a non-zero exit. */
export function runChecked(command: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { cwd, env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? 1}`);
}

/** The conventional 128+n exit code for a child killed by a signal. */
export function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return UNKNOWN_SIGNAL_EXIT_CODE;
  const signalNumber = osConstants.signals[signal];
  return signalNumber ? SIGNAL_EXIT_CODE_OFFSET + signalNumber : UNKNOWN_SIGNAL_EXIT_CODE;
}

/**
 * Runs an interactive child, forwarding terminal signals for its lifetime.
 *
 * Listeners are registered with `on` rather than `once` so a second Ctrl-C still
 * reaches the child, and removed in a finally so repeated launches in one
 * process do not accumulate handlers.
 */
export function forwardSignals(child: ChildProcess): () => void {
  const forward = (signal: NodeJS.Signals): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
  return () => {
    for (const signal of FORWARDED_SIGNALS) process.removeListener(signal, forward);
  };
}

/** Resolves with the child's exit code, or the conventional code for its signal. */
export function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? signalExitCode(signal)));
  });
}

export async function runInteractive(
  command: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  const child = spawn(command, args, { cwd, env: environment, stdio: 'inherit' });
  const stopForwarding = forwardSignals(child);
  try {
    return await waitForExit(child);
  } finally {
    stopForwarding();
  }
}

export function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

/** True when the recorded lock owner is still a live process. */
export function lockOwnerIsRunning(lockPath: string): boolean {
  const owner = readJson(path.join(lockPath, LOCK_OWNER_FILENAME));
  if (typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    // Anything other than "no such process" means the pid exists but is not
    // ours to signal, so the lock is still held.
    return !isFileSystemError(error) || error.code !== PROCESS_NOT_FOUND_ERROR;
  }
}

/**
 * Takes an exclusive lock by creating a directory, which is atomic everywhere.
 *
 * A lock older than the stale window whose owner is gone is reclaimed, so a
 * harness killed mid-sync cannot block every other repository forever.
 */
export async function acquireDirectoryLock(lockPath: string): Promise<() => Promise<void>> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();

  while (true) {
    try {
      await fs.promises.mkdir(lockPath);
      try {
        writeJson(path.join(lockPath, LOCK_OWNER_FILENAME), { pid: process.pid });
      } catch (error) {
        await fs.promises.rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      return () => fs.promises.rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (!isFileSystemError(error) || error.code !== FILE_EXISTS_ERROR) throw error;
      try {
        const stat = await fs.promises.stat(lockPath);
        if (Date.now() - stat.mtimeMs >= LOCK_STALE_MS && !lockOwnerIsRunning(lockPath)) {
          await fs.promises.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        // The holder released between the failed mkdir and this stat, so retry
        // immediately rather than waiting out the retry delay.
        if (isFileSystemError(statError) && statError.code === FILE_NOT_FOUND_ERROR) continue;
        throw statError;
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for Antigravity state lock: ${lockPath}`);
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

/** True when `candidate` is `root` itself or sits underneath it. */
export function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
