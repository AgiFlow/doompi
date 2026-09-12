import fs from 'node:fs';
import {
  GATE_MODE,
  LIVENESS_POLL_MS,
  MEMORY_BUFFER_FACTOR,
  NON_INTERACTIVE_ENV,
  TERM_GRACE_MS,
} from '../../constants/launcher';
import { PI_SESSION_ID_ENV } from '../../constants/session';
import {
  cleanupSupervisorFiles,
  NO_TERMINAL_INPUT_ENV,
  readExitMetadata,
  supervisorCommand,
  supervisorPaths,
  writeCommandSpec,
} from '../runnerSupervisor';
import type { IClock } from '../../types/clock';
import type { ILogFile } from '../../types/logFile';
import type { IProcessControl } from '../../types/processControl';
import { getResultMaxBytes } from '../runnerConfig';
import type { IRunnerPaths } from '../runnerPaths/type';

import type { ILauncher, LaunchRequest, RunHandle } from '../../types/launcher';
import type { ExitResult, ISpawner } from '../../types/spawner';

/**
 * Prompts belong on a screen, not in a log file, so `CI` stays set.
 *
 * Colour is kept: the log is replayed into the transcript, and the scrub keeps
 * SGR while still removing the cursor moves that made raw output unreadable.
 */
/** In-memory output is a multiple of the result ceiling; the log holds the rest. */

export class Launcher implements ILauncher {
  constructor(
    private readonly spawner: ISpawner,
    private readonly processControl: IProcessControl,
    private readonly logFile: ILogFile,
    private readonly clock: IClock,
    private readonly paths: IRunnerPaths,
  ) {}

  launch(request: LaunchRequest): RunHandle {
    const writer = this.logFile.open(request.id);
    const memoryLimit = getResultMaxBytes() * MEMORY_BUFFER_FACTOR;

    let buffer = '';
    let buffering = true;
    let settled = false;
    let resolveCompletion: (result: ExitResult) => void = () => undefined;
    let rejectCompletion: (error: Error) => void = () => undefined;
    const completion = new Promise<ExitResult>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    this.paths.ensureDirectories(request.sessionId);
    const supervisor = supervisorPaths(this.paths.stateDirectory(request.sessionId), request.id);
    const env = {
      ...process.env,
      ...NON_INTERACTIVE_ENV,
      ...NO_TERMINAL_INPUT_ENV,
      [PI_SESSION_ID_ENV]: request.sessionId,
    };
    cleanupSupervisorFiles(supervisor);
    writeCommandSpec(supervisor.spec, { command: request.command, cwd: request.cwd, env: defined(env) });
    // Nothing has to be attached before this runner starts, so its gate opens at once.
    fs.writeFileSync(supervisor.gate, '', { mode: GATE_MODE });

    const child = this.spawner.spawn({
      // runnerHost supervises the command: it forwards signals and, if the owning
      // pi dies without running its shutdown handler, kills the group itself.
      command: supervisorCommand(supervisor),
      cwd: request.cwd,
      env,
      // Its own process group, so stopping a runner takes the whole tree with it.
      detached: true,
    });

    const failLaunch = (error: unknown): void => {
      if (settled) return;
      settled = true;
      writer.close();
      cleanupSupervisorFiles(supervisor);
      try {
        child.kill('SIGTERM');
      } catch (killError) {
        process.emitWarning(`Could not stop runner after log failure: ${String(killError)}`);
      }
      rejectCompletion(error instanceof Error ? error : new Error(String(error)));
    };
    child.onOutput((chunk) => {
      if (settled) return;
      try {
        writer.append(chunk);
      } catch (error) {
        failLaunch(error);
        return;
      }
      if (!buffering) return;
      buffer += chunk;
      if (buffer.length > memoryLimit) buffer = buffer.slice(-memoryLimit);
    });

    child.onError(failLaunch);

    child.onExit((result) => {
      if (settled) return;
      settled = true;
      writer.close();
      // The supervisor collapses a signalled command into an exit code, so its
      // own sidecar is the only place the original signal survives.
      const outcome = readExitMetadata(supervisor.exit) ?? result;
      cleanupSupervisorFiles(supervisor);
      resolveCompletion(outcome);
    });

    // The launcher must never hold the pi process open on a runner's behalf.
    child.unref();

    const stop = async (): Promise<boolean> => (child.pid === undefined ? false : this.stop(child.pid));

    return {
      id: request.id,
      name: request.name,
      pid: child.pid,
      logPath: writer.path,
      backend: 'native',
      output: () => buffer,
      completion: () => completion,
      detach: () => {
        buffering = false;
        buffer = '';
      },
      stop,
    };
  }

  async stop(pid: number): Promise<boolean> {
    if (!this.processControl.isAlive(pid)) return false;

    this.processControl.signalGroup(pid, 'SIGTERM');
    const deadline = this.clock.now() + TERM_GRACE_MS;
    while (this.clock.now() < deadline) {
      if (!this.processControl.isAlive(pid)) return true;
      await this.sleep(LIVENESS_POLL_MS);
    }

    this.processControl.signalGroup(pid, 'SIGKILL');
    return true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.clock.after(ms, resolve);
    });
  }
}

/** The spec is JSON, which has no way to carry an unset variable. */
function defined(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
