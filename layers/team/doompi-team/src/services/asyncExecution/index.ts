/**
 * Parent-side launcher for bounded external Claude and Codex subprocesses.
 *
 * Native Pi runs never enter this adapter. They are started in-process through
 * the typed child-session service. External launch, readiness, control, status,
 * result, errors, and exit all use the child process IPC channel. Files written
 * by this path are durable logs and result artifacts only.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InlineAgent } from '../../schemas/subagentTool';
import { SUBAGENT_RUN_ID_ENV } from '../../types/environment';
import { scopeResultsDir, sessionScopeEnvironment, scopeRunsDir, type SessionScope } from '../sessionPaths';
import type { ActivityState, ArtifactDirPreference } from '../../types';
import { childProcessEndpoint, ExternalProcessIpc, type ExternalProcessEndpoint } from '../externalProcessIpc';
import {
  CLAUDE_FABLE_PROFILE,
  type ClaudeFableLaunch,
  cleanupClaudeFableLaunch,
  prepareClaudeFableLaunch,
} from '../claudeFableProfile';
import type { SubagentCapabilityCeiling } from '../../schemas/team/capabilityCeiling';
import { isPiRuntime, type RuntimeTable, resolveRuntimeLaunch } from '../runtimeRegistry';
import { type SpawnHandshakeContract, SpawnHandshake } from '../spawnHandshake';
import type { StatusWithRecentEntries } from '../statusWriter';

export const RUNNER_STDOUT_FILE_NAME = 'runner.stdout.log';
export const RUNNER_STDERR_FILE_NAME = 'runner.stderr.log';
export const FABLE_PROFILE_RESULT_FILE_NAME = 'fable-profile-result.json';
/**
 * The effective system prompt this run launched with, kept for the fleet
 * inspector's agent view.
 *
 * A SIDECAR RATHER THAN A FIELD ON status.json: `CoalescedStatusWriter`
 * rewrites the whole status file on every coalesced flush, and a system prompt
 * is kilobytes of text that never changes after spawn. Inlining it would put
 * that payload through every status write for the life of the run. This file
 * is written once, next to the status it belongs to.
 *
 * Written 0600 for the same reason `piArgs.ts` writes its prompt file that
 * way: a resolved prompt can carry inherited project context.
 */
export const SYSTEM_PROMPT_FILE_NAME = 'system-prompt.md';
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * `state`/`steps`/`parallelGroups`/`chainStepCount`/`workflowGraph`/
 * `pendingAppends` are declared as optional-and-widened, rather than a
 * runner-owned status type, so this SAME status shape is what
 * `chain-append.ts`'s `applyChainAppendRequest` (which expects
 * `AppendableChainStatus`, an object with exactly these optional fields) can
 * mutate directly - one status type for the whole spawn-through-finalize
 * lifecycle, not a parent-side one and a child-side one that have to be kept
 * in sync by hand.
 */
export interface AsyncRunStatus extends StatusWithRecentEntries {
  /** Version 1 is emitted by current writers; absent is accepted only by the compatibility reader. */
  version?: 1;
  runId: string;
  operationId?: string;
  agent: string;
  /** Original task text required to restore a suspended run. */
  task?: string;
  cwd?: string;
  /** Resolved model selected for this run, when one was requested. */
  model?: string;
  /** One-shot agent definition required to restore an inline agent. */
  inlineAgent?: InlineAgent;
  state: 'queued' | 'running' | 'complete' | 'completed' | 'failed' | 'paused' | 'stopped';
  startedAt: number;
  lastUpdate: number;
  endedAt?: number;
  /** This run's position among its fan-out siblings, when it has any. Absent for a standalone run. */
  fanoutIndex?: number;
  /** Bridge-owned runs are consumed internally and never rendered as generic completion chat. */
  internal?: boolean;
  /** Which runtime executes this run. Absent means the default in-process `pi` path. */
  runtime?: string;
  activityState?: ActivityState;
  attentionReason?: string;
  error?: string;
  /**
   * Set once, at finalize, by `RunnerReporting.mutateTerminalStatus` - the
   * SAME value it puts in the terminal result file, truncated to a bounded
   * length (see that module's header for why). Lets a caller (chain mode,
   * in particular) learn a completed run's own summary through the status
   * file it already reads to learn the run finished, rather than needing a
   * second read of a claimed, single-consumer result file.
   */
  summary?: string;
  /**
   * This run's own Pi session transcript path, written during child bootstrap
   * and retained by `RunnerReporting.mutateTerminalStatus` at finalize. See
   * that module's header for where the value comes from and why it is bounded
   * by omission, not truncation. Absent for a run that either never reported
   * a session file (headless, no persisted transcript) or reported one too
   * long to trust. This is what `action='resume'` reads to know which
   * transcript a later revival should reopen.
   */
  sessionFile?: string;
  /** Child-owned Pi SDK event transcript consumed by the fleet detail pane. */
  transcriptPath?: string;
  /**
   * Sidecar holding this run's effective system prompt, and the resolved tool
   * plan it launched with. Recorded at spawn purely so the fleet inspector can
   * show what an agent was actually told: the launch config that carried them
   * is deleted as soon as the child handshakes, and the agent definition on
   * disk can change while a run is still going.
   *
   * All absent for a non-`pi` runtime, which has no SDK launch settings, and
   * for any run started before this was recorded.
   */
  systemPromptPath?: string;
  systemPromptMode?: 'append' | 'replace';
  /** Effective tool allowlist. Absent means "whatever the child defaults to". */
  tools?: string[];
  excludeTools?: string[];
  noTools?: boolean;
  /** Cumulative tokens observed from finalized child messages. */
  tokens?: number;
  /** Cumulative cost observed from finalized child messages. */
  cost?: number;
  /** Most recently started child tool. */
  currentTool?: string;
  /** Number of child tool executions observed so far. */
  toolCount?: number;
}

export interface ExternalLaunchSettings {
  model?: string;
  capabilityCeiling?: SubagentCapabilityCeiling;
  sessionFile?: string;
  parentSessionId?: string;
}

export interface AsyncSubagentSpawnInput {
  runId: string;
  operationId?: string;
  agent: string;
  /** One-shot agent definition retained only for explicit suspension restore. */
  inlineAgent?: InlineAgent;
  task: string;
  cwd: string;
  /** Immutable environment admitted to the owning session. */
  environment: Readonly<Record<string, string | undefined>>;
  /** Persisted parent transcript used to place child artifacts beside the parent session. */
  parentSessionFile?: string;
  /** This spawn's position among its siblings. 0 for a standalone (non-fan-out) run. */
  childIndex: number;
  /** Whether this spawn is one of several children under a fan-out parent. */
  fanout: boolean;
  /** External CLI model and capability constraints. */
  piArgs: ExternalLaunchSettings;
  /** False disables the child event transcript. Defaults to enabled. */
  artifacts?: boolean;
  /** Suppress persistence of sensitive task text in status.json. */
  sensitiveTask?: boolean;
  /** Bridge-owned runs are consumed internally rather than rendered as generic chat. */
  internal?: boolean;
  /** Artifact root policy inherited from the parent Doom Team config. */
  artifactDir?: ArtifactDirPreference;
  handshakeTimeoutMs?: number;
  /**
   * Which runtime executes this run. Defaults to the in-process Pi SDK path.
   * Anything else is an external CLI resolved through `runtimeRegistry.ts`.
   */
  runtime?: string;
  /** Fixed trusted external profile. Only Doom Team internal bridges may set this. */
  externalProfile?: string;
  /** Session-owned filesystem root for this child run. */
  sessionScope: SessionScope;
  /** Runtimes available to this spawn, already merged with the shipped defaults. */
  runtimes?: RuntimeTable;
}

export interface AsyncSubagentSpawnResult {
  runId: string;
  pid: number;
}

export type AsyncSubagentSpawnerContract = {
  /** Spawn one child and return once it has confirmed it started. Throws on any failure to reach that point. */
  spawn(input: AsyncSubagentSpawnInput): Promise<AsyncSubagentSpawnResult>;
};

/** `runs/<runId>` under the explicit session scope. */
export function runDirFor(scope: SessionScope, runId: string): string {
  return path.join(scopeRunsDir(scope), runId);
}

export function fableProfileResultPathFor(scope: SessionScope, runId: string): string {
  return path.join(runDirFor(scope, runId), FABLE_PROFILE_RESULT_FILE_NAME);
}

/** Where `spawn()` records this run's effective system prompt. See `SYSTEM_PROMPT_FILE_NAME`. */
export function systemPromptPathFor(scope: SessionScope, runId: string): string {
  return path.join(runDirFor(scope, runId), SYSTEM_PROMPT_FILE_NAME);
}

/** Locate a child entry point on disk, built or source. */
function resolveRunnerEntry(builtRelativePath: string, sourceRelativePath: string, stem: string): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const packageManifest = path.join(directory, 'package.json');
    if (fs.existsSync(packageManifest)) {
      const builtCandidate = path.join(directory, 'dist', `${builtRelativePath}.mjs`);
      if (fs.existsSync(builtCandidate)) return builtCandidate;
      const sourceCandidate = path.join(directory, 'src', `${sourceRelativePath}.ts`);
      if (fs.existsSync(sourceCandidate)) return sourceCandidate;
      throw new Error(`Doom Team runner '${stem}' is unavailable at '${builtCandidate}' or '${sourceCandidate}'.`);
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Could not locate the Doom Team package root for runner '${stem}'.`);
    directory = parent;
  }
}

function resolveCliRunnerEntry(): string {
  return resolveRunnerEntry('runs/background/cliRunnerEntry', 'bin/cliRunner', 'cliRunnerEntry');
}

export class AsyncSubagentSpawner implements AsyncSubagentSpawnerContract {
  constructor(private readonly externalProcesses?: ExternalProcessIpc) {}

  /**
   * Runtime tuning seam for tests, kept out of the dependency constructor.
   */
  protected readonly defaultHandshakeTimeoutMs: number = DEFAULT_HANDSHAKE_TIMEOUT_MS;

  protected now(): number {
    return Date.now();
  }

  /** Spawn a detached external runner with a live IPC channel and durable output logs. */
  protected spawnChild(
    scope: SessionScope,
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ): {
    pid: number | undefined;
    onError: (handler: (error: Error) => void) => void;
    onExit: (handler: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
    onMessage?: (handler: (message: unknown) => void) => () => void;
    send?: (message: object) => Promise<void>;
    disconnect?: () => void;
  } {
    const runId = options.env[SUBAGENT_RUN_ID_ENV];
    let stdoutFd: number | undefined;
    let stderrFd: number | undefined;
    if (runId) {
      const runDir = runDirFor(scope, runId);
      fs.mkdirSync(runDir, { recursive: true });
      stdoutFd = fs.openSync(path.join(runDir, RUNNER_STDOUT_FILE_NAME), 'a', 0o600);
      try {
        stderrFd = fs.openSync(path.join(runDir, RUNNER_STDERR_FILE_NAME), 'a', 0o600);
      } catch (error) {
        fs.closeSync(stdoutFd);
        throw new Error(`Could not open runner stderr for '${runId}'.`, { cause: error });
      }
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        detached: true,
        // The fourth descriptor is the sole live control/status transport.
        stdio: ['ignore', stdoutFd ?? 'ignore', stderrFd ?? 'ignore', 'ipc'],
        windowsHide: true,
        env: options.env,
      });
    } finally {
      if (stdoutFd !== undefined) fs.closeSync(stdoutFd);
      if (stderrFd !== undefined) fs.closeSync(stderrFd);
    }
    child.unref();
    child.channel?.unref();
    const endpoint = childProcessEndpoint(child as unknown as Parameters<typeof childProcessEndpoint>[0]);
    return {
      pid: child.pid,
      onError: (handler) => child.on('error', handler),
      onExit: (handler) => child.on('exit', handler),
      onMessage: (handler) => endpoint.onMessage(handler),
      send: (message) => endpoint.send(message),
      disconnect: () => endpoint.disconnect?.(),
    };
  }

  /** Construct a fresh process handshake for one bounded external spawn. */
  protected createSpawnHandshake(): SpawnHandshakeContract {
    return new SpawnHandshake();
  }

  async spawn(input: AsyncSubagentSpawnInput): Promise<AsyncSubagentSpawnResult> {
    const { runId, agent, task, cwd, sessionScope: scope } = input;
    const runtime = input.runtime;
    if (isPiRuntime(runtime) || runtime === undefined) {
      throw new Error('Native Pi runs must be launched through the in-process child-session service.');
    }

    const externalProcesses = this.externalProcesses;
    if (!externalProcesses) throw new Error('External process IPC is not configured.');

    const runDir = runDirFor(scope, runId);
    const env: NodeJS.ProcessEnv = {
      ...input.environment,
      ...sessionScopeEnvironment(scope),
      [SUBAGENT_RUN_ID_ENV]: runId,
    };
    let fableLaunch: ClaudeFableLaunch | undefined;
    let launchConfig: Record<string, unknown>;
    const fail = (message: string): never => {
      if (fableLaunch) cleanupClaudeFableLaunch(fableLaunch);
      fs.rmSync(fableProfileResultPathFor(scope, runId), { force: true });
      throw new Error(message);
    };

    const ceiling = input.piArgs.capabilityCeiling;
    if (
      ceiling &&
      (!input.externalProfile || !(ceiling.allowedExternalProfiles ?? []).includes(input.externalProfile))
    ) {
      return fail(`External profile '${input.externalProfile ?? 'none'}' is denied by the active capability ceiling.`);
    }
    if (input.externalProfile !== undefined && input.externalProfile !== CLAUDE_FABLE_PROFILE) {
      return fail(`External profile '${input.externalProfile}' is not trusted.`);
    }
    if (input.externalProfile === CLAUDE_FABLE_PROFILE) {
      if (runtime !== 'claude' || input.piArgs.model !== 'fable') {
        return fail('The Fable profile requires runtime claude and model fable.');
      }
      if (input.inlineAgent || input.piArgs.sessionFile || input.piArgs.parentSessionId) {
        return fail('The Fable profile requires a fresh isolated context.');
      }
      fableLaunch = prepareClaudeFableLaunch({
        runId,
        prompt: task,
        repositoryCwd: cwd,
        privateRoot: runDir,
      });
      launchConfig = {
        runId,
        ...(input.operationId ? { operationId: input.operationId } : {}),
        agent,
        task,
        sensitiveTask: input.sensitiveTask === true,
        runtime: 'claude',
        command: fableLaunch.command,
        args: fableLaunch.args,
        cwd: fableLaunch.cwd,
        env: fableLaunch.env,
        profile: fableLaunch.profile,
        stdinPath: fableLaunch.stdinPath,
        cleanupPaths: fableLaunch.cleanupPaths,
        profileResultPath: fableProfileResultPathFor(scope, runId),
        resultPath: path.join(scopeResultsDir(scope), `${runId}.json`),
        internal: input.internal === true,
      };
    } else {
      launchConfig = {
        runId,
        ...(input.operationId ? { operationId: input.operationId } : {}),
        agent,
        task,
        sensitiveTask: input.sensitiveTask === true,
        ...resolveRuntimeLaunch(runtime, input.runtimes ?? {}, {
          prompt: task,
          model: input.piArgs.model,
          cwd,
        }),
        cwd,
        env: Object.fromEntries(
          Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        ),
        resultPath: path.join(scopeResultsDir(scope), `${runId}.json`),
        internal: input.internal === true,
      };
    }

    const child = this.spawnChild(scope, process.execPath, [resolveCliRunnerEntry()], {
      cwd,
      env,
    });
    if (child.pid === undefined) return fail(`Async spawn for '${agent}' (run '${runId}') did not produce a pid.`);
    if (!child.onMessage || !child.send) {
      return fail(`Async spawn for '${agent}' (run '${runId}') did not produce an IPC endpoint.`);
    }

    let spawnError: Error | undefined;
    child.onError((error) => {
      spawnError = error;
    });
    const endpoint: ExternalProcessEndpoint = {
      onMessage: child.onMessage,
      onExit: (handler) => {
        child.onExit(handler);
        return () => undefined;
      },
      send: child.send,
      ...(child.disconnect ? { disconnect: child.disconnect } : {}),
    };
    const unregister = externalProcesses.register(scope, runId, endpoint);
    const wait = this.createSpawnHandshake().waitForHandshake({
      child: endpoint,
      runId,
      scopeKey: scope.scopeKey,
      timeoutMs: input.handshakeTimeoutMs ?? this.defaultHandshakeTimeoutMs,
    });
    try {
      await externalProcesses.launch(scope, runId, launchConfig);
    } catch (error) {
      wait.cancel(error instanceof Error ? error.message : String(error));
      unregister();
      return fail(error instanceof Error ? error.message : String(error));
    }
    const outcome = await wait.promise;
    if (outcome.status !== 'signalled') {
      unregister();
      const message =
        outcome.status === 'failed'
          ? outcome.error
          : (spawnError?.message ?? `Timed out waiting for '${agent}' (run '${runId}') to start.`);
      return fail(message);
    }
    return { runId, pid: child.pid };
  }
}
