import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { type Pane, RMUX, type Rmux } from '@rmux/sdk';
import {
  type CommandSpec,
  cleanupSupervisorFiles,
  NO_TERMINAL_INPUT_ENV,
  readExitMetadata,
  runtimeEntry,
  type SupervisorPaths,
  shellJoin,
  supervisorPaths,
  writeCommandSpec,
} from '../../schemas/runnerSpec.ts';
import { getLogMaxBytes, getResultMaxBytes } from '../../types/config.ts';
import type { RunHandle } from '../../types/launcher';
import type { PtyRun } from '../../types/ptyHost';
import type { IRunnerPaths } from '../../services/RunnerPaths/types';
import type { ExitResult } from '../../types/spawner';
import type { IRmuxBackend, RmuxLaunchRequest } from '../../types/rmuxBackend';

const POLL_MS = 100;
const LOG_DRAIN_TIMEOUT_MS = 2_000;
const LOG_DRAIN_POLL_MS = 25;
/** Pane liveness, its exit status, and whether the session still exists, in one read. */
const PANE_STATE_FORMAT = '#{pane_dead}:#{pane_dead_status}:#{session_name}';
const STOP_GRACE_MS = 3_000;
const STOP_CLOSE_TIMEOUT_MS = 1_000;
const EXECUTABLE_MODE = 0o755;
const SESSION_PREFIX = 'doom-runner-';
const OWNED_TARGET_PATTERN = /^doom-runner-[A-Za-z0-9_-]+$/;
const SOCKET_HASH_LENGTH = 12;
const NON_INTERACTIVE_ENV = { NO_COLOR: '1', CI: '1' };
const PACKAGE_BY_PLATFORM: Readonly<Record<string, string>> = {
  'darwin-arm64': '@agimon-ai/doompi-runner-rmux-darwin-arm64',
  'darwin-x64': '@agimon-ai/doompi-runner-rmux-darwin-x64',
  'linux-arm64': '@agimon-ai/doompi-runner-rmux-linux-arm64',
  'linux-x64': '@agimon-ai/doompi-runner-rmux-linux-x64',
};

export class RmuxBackend implements IRmuxBackend {
  private clientPromise: Promise<Rmux | undefined> | undefined;
  private readonly runs = new Map<string, PtyRun>();
  private readonly completions = new Map<string, Promise<ExitResult>>();

  constructor(private readonly paths: IRunnerPaths) {}

  async launch(request: RmuxLaunchRequest): Promise<RunHandle | undefined> {
    const rmux = await this.client();
    if (!rmux) return undefined;

    this.paths.ensureDirectories();
    const target = `${SESSION_PREFIX}${request.id}`;
    const logPath = this.paths.logPathFor(request.id);
    const aux = this.auxPaths(request.id, request.sessionId);
    let created = false;
    let released = false;

    try {
      this.prepareFiles(request, logPath, aux);
      await rmux.cmd(
        'new-session',
        '-d',
        '-s',
        target,
        '-c',
        request.cwd,
        process.execPath,
        runtimeEntry('runnerHost'),
        aux.spec,
        aux.gate,
        aux.exit,
        { check: true },
      );
      created = true;
      // No remain-on-exit: a finished pane ends its session, and the last session
      // ending stops the server, so a completed run leaves no process behind.
      await rmux.cmd('pipe-pane', '-t', target, this.logPipeCommand(logPath, aux.logDone), { check: true });

      const pane = rmux.session(target).pane(0, 0);
      const pid = await panePid(rmux, target);
      fs.writeFileSync(aux.gate, '', { mode: 0o600 });
      released = true;

      let buffering = true;
      const completion = this.monitor(rmux, pane, target, aux);
      this.trackCompletion(target, completion);
      const stop = (): Promise<boolean> => this.stop(target, pid);
      const handle: RunHandle = {
        id: request.id,
        name: request.name,
        pid,
        logPath,
        backend: 'rmux',
        backendTarget: target,
        output: () => (buffering ? readTail(logPath, getResultMaxBytes() * 2) : ''),
        completion: () => completion,
        detach: () => {
          buffering = false;
        },
        stop,
      };

      if (request.interactive) this.runs.set(request.name, this.interactiveRun(handle, pane, completion));
      void completion
        .finally(() => this.runs.delete(request.name))
        .catch((error: unknown) => process.emitWarning(`RMUX completion failed for ${target}: ${errorMessage(error)}`));
      return handle;
    } catch (error) {
      if (released) throw error;
      if (created) {
        await rmux
          .session(target)
          .kill()
          .catch((cleanupError: unknown) =>
            process.emitWarning(`Could not clean up failed RMUX launch ${target}: ${errorMessage(cleanupError)}`),
          );
      }
      cleanupSupervisorFiles(aux);
      process.emitWarning(
        request.interactive
          ? `RMUX launch unavailable for interactive runner: ${errorMessage(error)}`
          : `RMUX launch unavailable, using supervised subprocess: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  async stop(target: string, expectedPid: number): Promise<boolean> {
    if (!OWNED_TARGET_PATTERN.test(target) || !Number.isInteger(expectedPid) || expectedPid <= 0) return false;

    const rmux = await this.client();
    if (!rmux) return false;
    try {
      // A session that already ended took its process group with it.
      if (await sessionMissing(rmux, target)) return true;

      const pid = await panePid(rmux, target);
      if (pid !== expectedPid) return false;
      const signalled = signalPane(pid, target);
      if (signalled === 'gone') return true;
      if (signalled === 'failed') return false;

      if (await waitForPaneStop(rmux, target, STOP_GRACE_MS)) return true;
      if (await sessionMissing(rmux, target)) return true;

      // Revalidate after the grace period so a replacement pane is never closed.
      const currentPid = await panePid(rmux, target);
      if (currentPid !== expectedPid) return false;

      return closeOwnedSession(rmux, target);
    } catch (error) {
      process.emitWarning(`Could not stop RMUX target ${target}: ${errorMessage(error)}`);
      return false;
    }
  }

  async watch(id: string, target: string, sessionId?: string): Promise<ExitResult | undefined> {
    const rmux = await this.client();
    if (!rmux) return undefined;
    const pane = rmux.session(target).pane(0, 0);
    try {
      await rmux.displayMessage('#{pane_id}', { target });
    } catch (error) {
      process.emitWarning(`Could not watch RMUX target ${target}: ${errorMessage(error)}`);
      return undefined;
    }
    const completion = this.monitor(rmux, pane, target, this.auxPaths(id, sessionId));
    this.trackCompletion(target, completion);
    return completion;
  }

  async input(target: string, text: string): Promise<boolean> {
    const rmux = await this.client();
    if (!rmux) return false;
    const result = await rmux
      .session(target)
      .pane(0, 0)
      .sendText(text)
      .catch((error: unknown) => {
        process.emitWarning(`Could not send input to RMUX target ${target}: ${errorMessage(error)}`);
        return undefined;
      });
    return result !== undefined;
  }

  get(name: string): PtyRun | undefined {
    return this.runs.get(name);
  }

  readOutcome(id: string, sessionId: string): ExitResult | undefined {
    return readExitMetadata(this.auxPaths(id, sessionId).exit);
  }

  private trackCompletion(target: string, completion: Promise<ExitResult>): void {
    this.completions.set(target, completion);
    void completion
      .finally(() => this.completions.delete(target))
      .catch((error: unknown) => process.emitWarning(`RMUX monitor failed for ${target}: ${errorMessage(error)}`));
  }

  private client(): Promise<Rmux | undefined> {
    this.clientPromise ??= this.resolveClient();
    return this.clientPromise;
  }

  private async resolveClient(): Promise<Rmux | undefined> {
    const binaries = [bundledBinary(), 'rmux'].filter((value): value is string => value !== undefined);
    for (const binary of binaries) {
      try {
        if (binary !== 'rmux') fs.chmodSync(binary, EXECUTABLE_MODE);
        const client = new RMUX({ binary, socketName: socketName(this.paths.repositoryPath()) });
        await client.capabilities();
        return client;
      } catch (error) {
        process.emitWarning(`RMUX candidate ${binary} is unavailable: ${errorMessage(error)}`);
        // Try the next compatible candidate. Non-interactive calls can use the subprocess launcher.
      }
    }
    return undefined;
  }

  private prepareFiles(request: RmuxLaunchRequest, logPath: string, aux: SupervisorPaths): void {
    cleanupSupervisorFiles(aux);
    fs.writeFileSync(logPath, '', { mode: 0o600 });
    const env = environment(request.sessionId, request.interactive);
    // runnerHost supervises the command and watches the lifeline itself, so an
    // owner that dies mid-run is handled inside the pane rather than around it.
    const spec: CommandSpec = { command: request.command, cwd: request.cwd, env };
    writeCommandSpec(aux.spec, spec);
  }

  private auxPaths(id: string, sessionId?: string): SupervisorPaths {
    return supervisorPaths(this.paths.stateDirectory(sessionId), id);
  }

  private logPipeCommand(logPath: string, donePath: string): string {
    return shellJoin([
      process.execPath,
      runtimeEntry('logSink'),
      logPath,
      this.paths.rotatedLogPathFor(path.basename(logPath, '.log')),
      String(getLogMaxBytes()),
      donePath,
    ]);
  }

  private async monitor(rmux: Rmux, pane: Pane, target: string, aux: SupervisorPaths): Promise<ExitResult> {
    try {
      const paneCode = await waitForRunEnd(rmux, target, aux.exit);
      await waitForLogDrain(rmux, target, aux.logDone);
      return readExitMetadata(aux.exit) ?? { code: paneCode, signal: null };
    } finally {
      // The pane ends its own session, so this only covers a session that somehow
      // outlived its pane. Killing unconditionally would warn on every clean run.
      if (!(await sessionMissing(rmux, target).catch(() => false))) {
        await pane.server
          .session(target)
          .kill()
          .catch((error: unknown) =>
            process.emitWarning(`Could not clean up completed RMUX target ${target}: ${errorMessage(error)}`),
          );
      }
      cleanupSupervisorFiles(aux);
    }
  }

  private interactiveRun(handle: RunHandle, pane: Pane, completion: Promise<ExitResult>): PtyRun {
    let screen = '';
    let active = true;
    const handlers = new Set<(data: string) => void>();
    const refresh = async (): Promise<void> => {
      while (active) {
        const next = await pane.captureText().catch((error: unknown) => {
          process.emitWarning(`Could not capture RMUX screen for ${handle.name}: ${errorMessage(error)}`);
          return screen;
        });
        if (next !== screen) {
          screen = next;
          for (const handler of handlers) handler(next);
        }
        await delay(POLL_MS);
      }
    };
    void refresh();
    void completion
      .finally(() => {
        active = false;
      })
      .catch((error: unknown) =>
        process.emitWarning(`RMUX interactive completion failed for ${handle.name}: ${errorMessage(error)}`),
      );
    return {
      ...handle,
      write: (text) => {
        void pane.sendText(text).catch((error: unknown) => process.emitWarning(errorMessage(error)));
      },
      screen: () => screen,
      onData: (handler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      resize: (cols, rows) => {
        void pane
          .resize({ width: cols, height: rows })
          .catch((error: unknown) => process.emitWarning(errorMessage(error)));
      },
    };
  }
}

export function rmuxPackageForTarget(platform: string, architecture: string): string | undefined {
  const target = `${platform}-${architecture}`;
  const packageName = PACKAGE_BY_PLATFORM[target];
  if (!packageName) process.emitWarning(`Bundled RMUX binary is unavailable for unsupported target ${target}`);
  return packageName;
}

function bundledBinary(): string | undefined {
  const packageName = rmuxPackageForTarget(process.platform, process.arch);
  if (!packageName) return undefined;
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(`${packageName}/package.json`);
    return path.join(path.dirname(manifest), 'vendor', 'bin', 'rmux');
  } catch (error) {
    process.emitWarning(`Bundled RMUX binary is unavailable for ${packageName}: ${errorMessage(error)}`);
    return undefined;
  }
}

function socketName(repositoryPath: string): string {
  const hash = createHash('sha256').update(repositoryPath).digest('hex').slice(0, SOCKET_HASH_LENGTH);
  return `${SESSION_PREFIX}${hash}`;
}

function environment(sessionId: string, interactive: boolean): Record<string, string> {
  const values: NodeJS.ProcessEnv = {
    ...process.env,
    ...(interactive ? {} : NON_INTERACTIVE_ENV),
    // Applied to interactive runs as well: a pane is a tty either way, and an
    // agent sending input to a prompt still has no way past a pager.
    ...NO_TERMINAL_INPUT_ENV,
    PI_SESSION_ID: sessionId,
  };
  if (!interactive) delete values['FORCE_COLOR'];
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

async function panePid(rmux: Rmux, target: string): Promise<number> {
  const response = await rmux.displayMessage('#{pane_pid}', { target });
  const pid = Number(response['message']);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`RMUX did not report a pane pid for ${target}`);
  return pid;
}

/**
 * Waits for the run to end, preferring the supervisor's own record of it.
 *
 * The sidecar is written before the command's pane can end, and it outlives the
 * server that the pane's exit takes down with it. Asking the server is the
 * fallback for a supervisor that died without recording anything.
 */
async function waitForRunEnd(rmux: Rmux, target: string, exitPath: string): Promise<number | null> {
  for (;;) {
    if (fs.existsSync(exitPath)) return null;
    const state = await readPaneExit(rmux, target);
    if (state.exited) return state.code;
    await delay(POLL_MS);
  }
}

/**
 * Gives the log sink a moment to mark the log complete.
 *
 * The sink dies with the session it was piped from, so once the session is gone
 * the marker is never coming and there is nothing left to wait for. Its writes
 * are synchronous, so the log itself is already on disk either way.
 */
async function waitForLogDrain(rmux: Rmux, target: string, donePath: string): Promise<void> {
  const deadline = Date.now() + LOG_DRAIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(donePath)) return;
    if (await sessionMissing(rmux, target)) return;
    await delay(LOG_DRAIN_POLL_MS);
  }
}

async function closeOwnedSession(rmux: Rmux, target: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      process.emitWarning(`Timed out closing RMUX target ${target} after ${STOP_CLOSE_TIMEOUT_MS}ms`);
      finish(false);
    }, STOP_CLOSE_TIMEOUT_MS);
    void rmux
      .session(target)
      .kill()
      .then(
        () => finish(true),
        (error: unknown) => {
          process.emitWarning(`Could not close RMUX target ${target}: ${errorMessage(error)}`);
          finish(false);
        },
      );
  });
}

async function waitForPaneStop(rmux: Rmux, target: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await readPaneExit(rmux, target)).exited) return true;
    } catch (error) {
      process.emitWarning(`Could not verify RMUX target ${target} stopped: ${errorMessage(error)}`);
      return false;
    }
    await delay(POLL_MS);
  }
  return false;
}

/**
 * One formatted read answers both questions this poll asks, so watching a run
 * costs the same single rmux call it always did.
 */
async function readPaneExit(rmux: Rmux, target: string): Promise<{ exited: boolean; code: number | null }> {
  let message: string;
  try {
    const response = await rmux.displayMessage(PANE_STATE_FORMAT, { target });
    message = typeof response['message'] === 'string' ? response['message'] : '';
  } catch {
    // The last session ending stops the server, so a server that cannot be
    // reached is the ordinary end of the last run rather than a fault.
    return { exited: true, code: null };
  }
  const [dead, status, ...rest] = message.trim().split(':');
  // A missing session formats as a live pane with no name rather than failing,
  // so the name is what says whether there is still anything to watch.
  if (rest.join(':') === '') return { exited: true, code: null };
  if (dead === '1' || dead === 'true') {
    const code = Number(status);
    return { exited: true, code: Number.isInteger(code) ? code : null };
  }
  return { exited: false, code: null };
}

/** A session that cannot be found, on a server that may itself be gone. */
async function sessionMissing(rmux: Rmux, target: string): Promise<boolean> {
  try {
    const probe = await rmux.cmd('has-session', '-t', target);
    return probe.returnCode !== 0;
  } catch {
    // No server to ask means no session to find.
    return true;
  }
}

/**
 * A pane that was already gone and a signal that could not be delivered are
 * opposite answers to "is it stopped", so they are reported apart.
 */
function signalPane(pid: number, target: string): 'signalled' | 'gone' | 'failed' {
  try {
    process.kill(pid, 'SIGTERM');
    return 'signalled';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone';
    process.emitWarning(`Could not signal RMUX target ${target}: ${errorMessage(error)}`);
    return 'failed';
  }
}

function readTail(target: string, maxBytes: number): string {
  let handle: number | undefined;
  try {
    const size = fs.statSync(target).size;
    const bytes = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(bytes);
    handle = fs.openSync(target, 'r');
    fs.readSync(handle, buffer, 0, bytes, size - bytes);
    return buffer.toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.emitWarning(`Could not read RMUX log ${target}: ${errorMessage(error)}`);
    }
    return '';
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
