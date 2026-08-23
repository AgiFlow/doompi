import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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
import type { ITmuxClient } from '../../types/tmuxClient';
import { TmuxClient } from './TmuxClient.ts';

const POLL_MS = 100;
const LOG_DRAIN_TIMEOUT_MS = 2_000;
const LOG_DRAIN_POLL_MS = 25;
/** Pane liveness, its exit status, and whether the session still exists, in one read. */
const PANE_STATE_FORMAT = '#{pane_dead}:#{pane_dead_status}:#{session_name}';
const STOP_GRACE_MS = 3_000;
/** Distinct from the RMUX prefix so a target names the backend that owns it. */
const SESSION_PREFIX = 'doom-tmux-';
const OWNED_TARGET_PATTERN = /^doom-tmux-[A-Za-z0-9_-]+$/;
export const TMUX_TARGET_PREFIX = SESSION_PREFIX;
const SOCKET_HASH_LENGTH = 12;
const SOCKET_PREFIX = 'doom-tmux-';
const NON_INTERACTIVE_ENV = { NO_COLOR: '1', CI: '1' };

/**
 * Supervises runs in tmux panes, for hosts with no compatible RMUX binary.
 *
 * The pane runs the same runnerHost supervisor as the RMUX backend, so exit
 * metadata, log rotation, and lifeline handling are shared rather than
 * reimplemented: only the multiplexer differs. Kept beside the RMUX backend
 * rather than folded into it because that path has no unit coverage to
 * refactor against.
 */
export class TmuxBackend implements IRmuxBackend {
  private clientPromise: Promise<ITmuxClient | undefined> | undefined;
  private readonly runs = new Map<string, PtyRun>();
  private readonly completions = new Map<string, Promise<ExitResult>>();

  constructor(
    private readonly paths: IRunnerPaths,
    private readonly createClient: (socket: string) => ITmuxClient = (socket) => new TmuxClient(socket),
  ) {}

  async launch(request: RmuxLaunchRequest): Promise<RunHandle | undefined> {
    const tmux = await this.client();
    if (!tmux) return undefined;

    this.paths.ensureDirectories();
    const target = `${SESSION_PREFIX}${request.id}`;
    const logPath = this.paths.logPathFor(request.id);
    const aux = this.auxPaths(request.id, request.sessionId);
    let created = false;
    let released = false;

    try {
      this.prepareFiles(request, logPath, aux);
      // One quoted command rather than an argv: tmux takes shell-command as a
      // single word, and quoting here is what keeps a path with spaces intact.
      const supervisor = shellJoin([process.execPath, runtimeEntry('runnerHost'), aux.spec, aux.gate, aux.exit]);
      await this.checked(tmux, ['new-session', '-d', '-s', target, '-c', request.cwd, supervisor]);
      created = true;
      // Set before the gate opens, so it is in force by the time the command
      // can exit. A pane that vanishes on exit takes the log sink down with it
      // before Node has finished starting, losing the output of fast commands,
      // and leaves #{pane_dead} with nothing to report.
      await this.checked(tmux, ['set-option', '-t', target, 'remain-on-exit', 'on']);
      await this.checked(tmux, ['pipe-pane', '-t', target, this.logPipeCommand(logPath, aux.logDone)]);

      const pid = await panePid(tmux, target);
      fs.writeFileSync(aux.gate, '', { mode: 0o600 });
      released = true;

      let buffering = true;
      const completion = this.monitor(tmux, target, aux);
      this.trackCompletion(target, completion);
      const handle: RunHandle = {
        id: request.id,
        name: request.name,
        pid,
        logPath,
        backend: 'tmux',
        backendTarget: target,
        output: () => (buffering ? readTail(logPath, getResultMaxBytes() * 2) : ''),
        completion: () => completion,
        detach: () => {
          buffering = false;
        },
        stop: () => this.stop(target, pid),
      };

      if (request.interactive) this.runs.set(request.name, this.interactiveRun(handle, tmux, target, completion));
      void completion
        .finally(() => this.runs.delete(request.name))
        .catch((error: unknown) => process.emitWarning(`tmux completion failed for ${target}: ${errorMessage(error)}`));
      return handle;
    } catch (error) {
      if (released) throw error;
      if (created) await killSession(tmux, target);
      cleanupSupervisorFiles(aux);
      process.emitWarning(
        request.interactive
          ? `tmux launch unavailable for interactive runner: ${errorMessage(error)}`
          : `tmux launch unavailable, using supervised subprocess: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  async stop(target: string, expectedPid: number): Promise<boolean> {
    if (!OWNED_TARGET_PATTERN.test(target) || !Number.isInteger(expectedPid) || expectedPid <= 0) return false;

    const tmux = await this.client();
    if (!tmux) return false;
    try {
      if (await tmux.sessionMissing(target)) return true;

      const pid = await panePid(tmux, target);
      if (pid !== expectedPid) return false;
      const signalled = signalPane(pid, target);
      if (signalled === 'gone') return true;
      if (signalled === 'failed') return false;

      if (await waitForPaneStop(tmux, target, STOP_GRACE_MS)) return true;
      if (await tmux.sessionMissing(target)) return true;

      // Revalidate after the grace period so a replacement pane is never closed.
      const currentPid = await panePid(tmux, target).catch(() => undefined);
      if (currentPid !== expectedPid) return false;

      return killSession(tmux, target);
    } catch (error) {
      process.emitWarning(`Could not stop tmux target ${target}: ${errorMessage(error)}`);
      return false;
    }
  }

  async watch(id: string, target: string, sessionId?: string): Promise<ExitResult | undefined> {
    const tmux = await this.client();
    if (!tmux) return undefined;
    if (await tmux.sessionMissing(target)) return undefined;
    const completion = this.monitor(tmux, target, this.auxPaths(id, sessionId));
    this.trackCompletion(target, completion);
    return completion;
  }

  async input(target: string, text: string): Promise<boolean> {
    const tmux = await this.client();
    if (!tmux) return false;
    const result = await tmux.run(['send-keys', '-t', target, '-l', text]).catch((error: unknown) => {
      process.emitWarning(`Could not send input to tmux target ${target}: ${errorMessage(error)}`);
      return undefined;
    });
    return result?.returnCode === 0;
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
      .catch((error: unknown) => process.emitWarning(`tmux monitor failed for ${target}: ${errorMessage(error)}`));
  }

  private client(): Promise<ITmuxClient | undefined> {
    this.clientPromise ??= this.resolveClient();
    return this.clientPromise;
  }

  private async resolveClient(): Promise<ITmuxClient | undefined> {
    const client = this.createClient(socketName(this.paths.repositoryPath()));
    try {
      const version = await client.run(['-V']);
      if (version.returnCode !== 0) throw new Error(version.stderr.trim() || 'tmux reported no version');
      return client;
    } catch (error) {
      process.emitWarning(`tmux is unavailable: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private async checked(tmux: ITmuxClient, args: readonly string[]): Promise<void> {
    const result = await tmux.run(args);
    if (result.returnCode !== 0) {
      throw new Error(`tmux ${args[0] ?? ''} failed: ${result.stderr.trim() || `exit ${result.returnCode}`}`);
    }
  }

  private prepareFiles(request: RmuxLaunchRequest, logPath: string, aux: SupervisorPaths): void {
    cleanupSupervisorFiles(aux);
    fs.writeFileSync(logPath, '', { mode: 0o600 });
    const env = environment(request.sessionId, request.interactive);
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

  private async monitor(tmux: ITmuxClient, target: string, aux: SupervisorPaths): Promise<ExitResult> {
    try {
      const paneCode = await waitForRunEnd(tmux, target, aux.exit);
      await waitForLogDrain(tmux, target, aux.logDone);
      return readExitMetadata(aux.exit) ?? { code: paneCode, signal: null };
    } finally {
      if (!(await tmux.sessionMissing(target).catch(() => false))) await killSession(tmux, target);
      cleanupSupervisorFiles(aux);
    }
  }

  private interactiveRun(
    handle: RunHandle,
    tmux: ITmuxClient,
    target: string,
    completion: Promise<ExitResult>,
  ): PtyRun {
    let screen = '';
    let active = true;
    const handlers = new Set<(data: string) => void>();
    const refresh = async (): Promise<void> => {
      while (active) {
        const captured = await tmux.run(['capture-pane', '-p', '-t', target]).catch((error: unknown) => {
          process.emitWarning(`Could not capture tmux screen for ${handle.name}: ${errorMessage(error)}`);
          return undefined;
        });
        const next = captured?.returnCode === 0 ? captured.stdout : screen;
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
        process.emitWarning(`tmux interactive completion failed for ${handle.name}: ${errorMessage(error)}`),
      );
    return {
      ...handle,
      write: (text) => {
        void tmux
          .run(['send-keys', '-t', target, '-l', text])
          .catch((error: unknown) => process.emitWarning(errorMessage(error)));
      },
      screen: () => screen,
      onData: (handler) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      resize: (cols, rows) => {
        void tmux
          .run(['resize-window', '-t', target, '-x', String(cols), '-y', String(rows)])
          .catch((error: unknown) => process.emitWarning(errorMessage(error)));
      },
    };
  }
}

function socketName(repositoryPath: string): string {
  const hash = createHash('sha256').update(repositoryPath).digest('hex').slice(0, SOCKET_HASH_LENGTH);
  return `${SOCKET_PREFIX}${hash}`;
}

function environment(sessionId: string, interactive: boolean): Record<string, string> {
  const values: NodeJS.ProcessEnv = {
    ...process.env,
    ...(interactive ? {} : NON_INTERACTIVE_ENV),
    ...NO_TERMINAL_INPUT_ENV,
    PI_SESSION_ID: sessionId,
  };
  if (!interactive) delete values['FORCE_COLOR'];
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

async function killSession(tmux: ITmuxClient, target: string): Promise<boolean> {
  const result = await tmux.run(['kill-session', '-t', target]).catch((error: unknown) => {
    process.emitWarning(`Could not close tmux target ${target}: ${errorMessage(error)}`);
    return undefined;
  });
  return result?.returnCode === 0;
}

async function panePid(tmux: ITmuxClient, target: string): Promise<number> {
  const message = await tmux.format(target, '#{pane_pid}');
  const pid = Number(message);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`tmux did not report a pane pid for ${target}`);
  return pid;
}

/**
 * Waits for the run to end, preferring the supervisor's own record of it.
 *
 * The sidecar is written before the pane can end and outlives the server the
 * pane's exit takes down, so asking tmux is the fallback for a supervisor that
 * died without recording anything.
 */
async function waitForRunEnd(tmux: ITmuxClient, target: string, exitPath: string): Promise<number | null> {
  for (;;) {
    if (fs.existsSync(exitPath)) return null;
    const state = await readPaneExit(tmux, target);
    if (state.exited) return state.code;
    await delay(POLL_MS);
  }
}

async function waitForLogDrain(tmux: ITmuxClient, target: string, donePath: string): Promise<void> {
  const deadline = Date.now() + LOG_DRAIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(donePath)) return;
    if (await tmux.sessionMissing(target)) return;
    await delay(LOG_DRAIN_POLL_MS);
  }
}

async function waitForPaneStop(tmux: ITmuxClient, target: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await readPaneExit(tmux, target)).exited) return true;
    await delay(POLL_MS);
  }
  return false;
}

/** One formatted read answers both questions this poll asks. */
async function readPaneExit(tmux: ITmuxClient, target: string): Promise<{ exited: boolean; code: number | null }> {
  const message = await tmux.format(target, PANE_STATE_FORMAT);
  // An unreachable server is the ordinary end of the last run: the pane exiting
  // ends its session, and the last session ending stops the server.
  if (message === undefined) return { exited: true, code: null };
  const [dead, status, ...rest] = message.trim().split(':');
  if (rest.join(':') === '') return { exited: true, code: null };
  if (dead === '1' || dead === 'true') {
    const code = Number(status);
    return { exited: true, code: Number.isInteger(code) ? code : null };
  }
  return { exited: false, code: null };
}

function signalPane(pid: number, target: string): 'signalled' | 'gone' | 'failed' {
  try {
    process.kill(pid, 'SIGTERM');
    return 'signalled';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone';
    process.emitWarning(`Could not signal tmux target ${target}: ${errorMessage(error)}`);
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
      process.emitWarning(`Could not read tmux log ${target}: ${errorMessage(error)}`);
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
