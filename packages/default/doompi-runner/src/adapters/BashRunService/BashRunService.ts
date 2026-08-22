import { randomBytes } from 'node:crypto';
import { getBackgroundThresholdMs } from '../../types/config.ts';
import type { IClock } from '../../types/clock';
import type { ILauncher, RunHandle } from '../../types/launcher';
import type { IRmuxBackend } from '../../types/rmuxBackend';
import { type IRtkProcessor, RTK_FAILED_WARNING } from '../../types/rtkProcessor';
import type { IRunnerNamer } from '../../services/RunnerNamer/types';
import type { IRunnerRegistry } from '../../types/runnerRegistry';
import type {
  BashRunRequest,
  BashRunResult,
  CompletedRun,
  IBashRunService,
  PromotedRun,
} from '../../types/bashRunService';

/** The command outlived the background threshold and should be promoted. */
const TIMED_OUT = Symbol('threshold-reached');
/** The command outlived the caller's explicit timeout and should be stopped. */
const DEADLINE = Symbol('deadline-reached');
const RUNNER_ID_RANDOM_BYTES = 3;
const OUTPUT_UPDATE_POLL_MS = 100;
const COMPLETED = 'completed';
const FAILED = 'failed';
const LAUNCHER_ERROR = 'launcher_error';
const SIGNALED = 'signaled';

function runnerId(): string {
  const timestamp = Date.now().toString(36);
  const random = randomBytes(RUNNER_ID_RANDOM_BYTES).toString('base64url');
  return `${timestamp}-${random}`;
}

export class BashRunService implements IBashRunService {
  constructor(
    private readonly launcher: ILauncher,
    private readonly rmuxBackend: IRmuxBackend,
    private readonly namer: IRunnerNamer,
    private readonly registry: IRunnerRegistry,
    private readonly clock: IClock,
    private readonly rtkProcessor: IRtkProcessor,
  ) {}

  async run(request: BashRunRequest): Promise<BashRunResult> {
    const id = runnerId();
    const name = await this.namer.allocate(request.command, request.sessionId, request.name);
    const cwd = request.cwd ?? process.cwd();
    const interactive = request.interactive === true;

    let handle: RunHandle;
    try {
      const rmuxHandle = await this.rmuxBackend.launch({
        id,
        name,
        command: request.command,
        cwd,
        sessionId: request.sessionId,
        interactive,
      });
      if (interactive && !rmuxHandle) {
        return { kind: FAILED, id, name, error: 'RMUX is required for interactive commands but is unavailable' };
      }
      handle =
        rmuxHandle ?? this.launcher.launch({ id, name, command: request.command, cwd, sessionId: request.sessionId });
    } catch (error) {
      return { kind: FAILED, id, name, error: error instanceof Error ? error.message : String(error) };
    }

    if (handle.pid === undefined) {
      return { kind: FAILED, id, name, error: 'The command did not start, so it cannot be supervised' };
    }

    try {
      await this.registry.register({
        id,
        name,
        pid: handle.pid,
        command: request.command,
        cwd,
        logPath: handle.logPath,
        interactive,
        sessionId: request.sessionId,
        backend: handle.backend,
        ...(handle.backendTarget ? { backendTarget: handle.backendTarget } : {}),
      });
    } catch (error) {
      await handle.stop();
      return { kind: FAILED, id, name, error: error instanceof Error ? error.message : String(error) };
    }

    // An interactive run has nothing to wait for: it is going to prompt, so
    // the model needs the runner name before it can answer.
    if (request.background === true || interactive) {
      return this.promote(handle, request.background === true ? 'requested' : 'interactive');
    }

    const outputUpdates = request.onOutput ? this.followOutput(handle, request.onOutput) : undefined;
    try {
      const outcome = await this.race(handle, request.timeoutMs);
      outputUpdates?.flush();
      if (outcome === TIMED_OUT) {
        return this.promote(handle, 'threshold');
      }
      if (outcome === DEADLINE) {
        // An explicit timeout means the caller wants the command dead, not
        // supervised, so it is stopped rather than promoted.
        await handle.stop();
        outputUpdates?.flush();
        await this.registry.complete(id, { reason: 'timed_out', code: null, signal: 'SIGTERM' });
        return {
          kind: COMPLETED,
          id,
          name,
          output: handle.output(),
          exitCode: null,
          signal: 'SIGTERM',
          logPath: handle.logPath,
          backend: handle.backend,
          timedOut: true,
        };
      }
      if (outcome instanceof Error) {
        await this.registry.complete(id, { reason: LAUNCHER_ERROR, code: null, signal: null });
        return { kind: FAILED, id, name, error: outcome.message };
      }

      await this.registry.complete(id, {
        reason: outcome.signal ? SIGNALED : outcome.code === 0 ? COMPLETED : FAILED,
        code: outcome.code,
        signal: outcome.signal,
      });

      return {
        kind: COMPLETED,
        id,
        name,
        output: handle.output(),
        exitCode: outcome.code,
        signal: outcome.signal,
        logPath: handle.logPath,
        backend: handle.backend,
        ...(await this.processLog(request.command, handle.logPath)),
      };
    } finally {
      outputUpdates?.dispose();
    }
  }

  private async processLog(command: string, logPath: string): Promise<Pick<CompletedRun, 'rtkOutput' | 'rtkWarning'>> {
    try {
      const result = await this.rtkProcessor.process({ command, logPath });
      if (result.kind === 'processed') return { rtkOutput: result.result };
      if (result.kind === 'fallback') return { rtkWarning: result.warning };
      return {};
    } catch {
      return { rtkWarning: RTK_FAILED_WARNING };
    }
  }

  private followOutput(
    handle: RunHandle,
    onOutput: NonNullable<BashRunRequest['onOutput']>,
  ): { flush(): void; dispose(): void } {
    let active = true;
    let previous = '';
    let cancelPoll: (() => void) | undefined;
    const flush = (): void => {
      if (!active) return;
      const output = handle.output();
      if (output === previous) return;
      previous = output;
      onOutput(output);
    };
    const poll = (): void => {
      if (!active) return;
      flush();
      if (active) cancelPoll = this.clock.after(OUTPUT_UPDATE_POLL_MS, poll);
    };
    cancelPoll = this.clock.after(OUTPUT_UPDATE_POLL_MS, poll);
    return {
      flush,
      dispose: () => {
        active = false;
        cancelPoll?.();
        cancelPoll = undefined;
      },
    };
  }

  /**
   * Waits for the command, giving up at the background threshold or at the
   * caller's timeout, whichever comes first.
   *
   * A rejected completion is returned rather than thrown so the caller can
   * report a start failure as a tool result instead of an exception.
   */
  private async race(
    handle: RunHandle,
    timeoutMs: number | undefined,
  ): Promise<Awaited<ReturnType<RunHandle['completion']>> | Error | typeof TIMED_OUT | typeof DEADLINE> {
    const cancels: Array<() => void> = [];
    const racers: Array<Promise<unknown>> = [handle.completion().catch((error: Error) => error)];

    racers.push(
      new Promise((resolve) => {
        cancels.push(this.clock.after(getBackgroundThresholdMs(), () => resolve(TIMED_OUT)));
      }),
    );
    if (timeoutMs !== undefined && timeoutMs > 0) {
      racers.push(
        new Promise((resolve) => {
          cancels.push(this.clock.after(timeoutMs, () => resolve(DEADLINE)));
        }),
      );
    }

    try {
      return (await Promise.race(racers)) as Awaited<ReturnType<RunHandle['completion']>> | Error | typeof TIMED_OUT;
    } finally {
      for (const cancel of cancels) cancel();
    }
  }

  private async promote(handle: RunHandle, reason: PromotedRun['reason']): Promise<BashRunResult> {
    if (handle.pid === undefined)
      return { kind: FAILED, id: handle.id, name: handle.name, error: 'The command did not start' };
    await this.registry.markPromoted(handle.id);
    // Registration first: an unregistered runner is invisible, and the handle
    // stops buffering the moment it is detached.
    handle.detach();
    void handle
      .completion()
      .then(
        (outcome) =>
          this.registry.complete(handle.id, {
            reason: outcome.signal ? SIGNALED : outcome.code === 0 ? COMPLETED : FAILED,
            code: outcome.code,
            signal: outcome.signal,
          }),
        () => this.registry.complete(handle.id, { reason: LAUNCHER_ERROR, code: null, signal: null }),
      )
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.emitWarning(`Failed to complete runner ${handle.id}: ${message}`);
      });

    return {
      kind: 'promoted',
      id: handle.id,
      name: handle.name,
      pid: handle.pid,
      logPath: handle.logPath,
      backend: handle.backend,
      reason,
    };
  }
}
