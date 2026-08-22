import { spawn as spawnProcess } from 'node:child_process';
import type {
  HookCommand,
  HookDecision,
  HookOutcome,
  HookPayload,
  HookRunOptions,
  HookRunner,
} from '../types/hooks.ts';
import { HOOK_TELEMETRY_EVENT, type HookTelemetry } from '../types/telemetry.ts';

const HOOK_SHELL = '/bin/bash';
const HOOK_SHELL_COMMAND_FLAG = '-c';
const HOOK_TERMINATION_GRACE_MS = 2_000;
const DEFAULT_HOOK_TIMEOUT_SECONDS = 10;
const MILLISECONDS_PER_SECOND = 1_000;
const PROCESS_NOT_FOUND_ERROR = 'ESRCH';
const WINDOWS_PLATFORM = 'win32';
const UNKNOWN_EXIT_CODE = -1;
const JSON_LINE_START = '{';
const LINE_BREAK = /\r?\n/;

export interface BashHookRunnerOptions {
  telemetry?: HookTelemetry;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: typeof spawnProcess;
  warn?: (message: string) => void;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined;
}

/**
 * Runs advisory hook commands through bash and reports what each one decided.
 *
 * A hook is a command the repository owns, so it is spawned in its own process
 * group and terminated as one: a hook that starts a server and stalls should
 * not leave the server behind when the timeout fires.
 */
export function createBashHookRunner(options: BashHookRunnerOptions = {}): HookRunner {
  const spawn = options.spawn ?? spawnProcess;
  const telemetry = options.telemetry;
  const warn = options.warn ?? ((message: string) => void process.stderr.write(message));
  const useProcessGroup = (options.platform ?? process.platform) !== WINDOWS_PLATFORM;

  const signalOwnedProcess = (
    pid: number | undefined,
    kill: (signal: NodeJS.Signals) => void,
  ): ((signal: NodeJS.Signals) => void) => {
    return (signal) => {
      try {
        if (useProcessGroup && pid !== undefined) {
          process.kill(-pid, signal);
          return;
        }
        kill(signal);
      } catch (error) {
        if (errorCode(error) !== PROCESS_NOT_FOUND_ERROR) {
          process.emitWarning(`Could not signal repository hook process: ${String(error)}`);
        }
      }
    };
  };

  return {
    run(hook: HookCommand, payload: HookPayload, runOptions: HookRunOptions): Promise<HookOutcome> {
      const timeoutSeconds = hook.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS;
      const environment = options.env ?? process.env;
      return new Promise((resolve) => {
        // -c, not -lc. Hooks run on every tool call, and a login shell would
        // source the developer's profile each time: per-call latency plus hook
        // behavior that varies with their dotfiles. The child inherits the
        // environment below, so it keeps the PATH the launcher started with.
        const child = spawn(HOOK_SHELL, [HOOK_SHELL_COMMAND_FLAG, hook.command], {
          cwd: runOptions.repoRoot,
          env: {
            ...environment,
            CLAUDE_PROJECT_DIR: runOptions.repoRoot,
            CODEX_REPO_ROOT: runOptions.repoRoot,
            ORIGINAL_REPO_PATH: environment.ORIGINAL_REPO_PATH ?? runOptions.repoRoot,
            ...(runOptions.pluginRoot ? { CLAUDE_PLUGIN_ROOT: runOptions.pluginRoot } : {}),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: useProcessGroup,
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;
        let childExited = false;
        let timeoutExitCode: number | null = null;
        let escalationTimer: NodeJS.Timeout | undefined;

        const signal = signalOwnedProcess(child.pid, (value) => child.kill(value));

        const ownedProcessIsAlive = (): boolean => {
          if (!useProcessGroup || child.pid === undefined) return !childExited;
          try {
            process.kill(-child.pid, 0);
            return true;
          } catch (error) {
            return errorCode(error) !== PROCESS_NOT_FOUND_ERROR;
          }
        };

        const finish = (outcome: HookOutcome = {}): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (escalationTimer) clearTimeout(escalationTimer);
          resolve(outcome);
        };

        const finishTimeout = (): void => {
          const message = `Hook timed out after ${timeoutSeconds} seconds.`;
          void telemetry?.recordWarning(HOOK_TELEMETRY_EVENT.hookFailed, message, {
            'hook.reason': 'timeout',
            'hook.exit_code': timeoutExitCode ?? UNKNOWN_EXIT_CODE,
          });
          warn(`[pi-hook] advisory hook timed out: ${hook.command}\n${stderr}`);
          finish({ failure: { command: hook.command, message, reason: 'timeout' } });
        };

        const timer = setTimeout(() => {
          timedOut = true;
          signal('SIGTERM');
          escalationTimer = setTimeout(() => {
            if (ownedProcessIsAlive()) signal('SIGKILL');
            finishTimeout();
          }, HOOK_TERMINATION_GRACE_MS);
        }, timeoutSeconds * MILLISECONDS_PER_SECOND);

        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.once('error', (error: Error) => {
          if (timedOut) return;
          // A guardrail that never ran is indistinguishable from one that
          // passed, which is the whole reason these are worth reporting.
          void telemetry?.recordError(HOOK_TELEMETRY_EVENT.hookFailed, error, { 'hook.reason': 'spawn_failed' });
          warn(`[pi-hook] advisory hook failed: ${error.message}\n`);
          finish({ failure: { command: hook.command, message: error.message, reason: 'spawn_failed' } });
        });
        child.once('exit', (code: number | null) => {
          childExited = true;
          timeoutExitCode = code;
          if (timedOut) return;
          if (code !== 0) {
            const message = stderr.trim() || `Advisory hook exited with code ${code ?? 'unknown'}`;
            void telemetry?.recordWarning(HOOK_TELEMETRY_EVENT.hookFailed, message, {
              'hook.reason': 'non_zero_exit',
              'hook.exit_code': code ?? UNKNOWN_EXIT_CODE,
            });
            warn(`[pi-hook] advisory hook failed (${code}): ${hook.command}\n${stderr}`);
            finish({ failure: { command: hook.command, message, reason: 'non_zero_exit' } });
            return;
          }
          const jsonLine = stdout
            .trim()
            .split(LINE_BREAK)
            .reverse()
            .find((line) => line.startsWith(JSON_LINE_START));
          if (!jsonLine) {
            finish();
            return;
          }
          try {
            finish({ decision: JSON.parse(jsonLine) as HookDecision });
          } catch (error) {
            // The hook ran and had an opinion, and it was dropped.
            void telemetry?.recordWarning(HOOK_TELEMETRY_EVENT.hookFailed, error, { 'hook.reason': 'invalid_json' });
            warn(`[pi-hook] advisory hook returned invalid JSON: ${hook.command}\n`);
            finish({
              failure: {
                command: hook.command,
                message: error instanceof Error ? error.message : String(error),
                reason: 'invalid_json',
              },
            });
          }
        });
        child.stdin?.end(JSON.stringify(payload));
      });
    },
  };
}
