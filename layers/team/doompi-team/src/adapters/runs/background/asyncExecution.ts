/**
 * The async-only spawn executor: launches exactly one subagent child process
 * and returns a run handle immediately, without waiting for the run to
 * finish.
 *
 * SCOPE - PARENT SIDE ONLY, SINGLE SPAWN:
 * `doom-pi-subagents/src/runs/background/asyncExecution.ts` is 1698 lines
 * doing far more than spawning: chain/parallel-group orchestration (building
 * `AgentConfig[]` sequences, dynamic fan-out expansion, workflow-graph
 * snapshots), session revival (a 3-way ready/ack/proceed handshake distinct
 * from the plain started-signal this module uses), and the foreground
 * (synchronous, blocking) code path. None of that is ported here:
 * - Chain/fan-out ORCHESTRATION (deciding how many children to spawn, in
 *   what order, from what step list) is `port-steering`'s concurrent work on
 *   the resolved-step and workflow-graph types. This module is the
 *   PRIMITIVE that orchestration calls once per child - `childIndex` and
 *   `fanout` arrive as inputs, already decided by the caller, not derived
 *   here (see the child-index section below for why that is safe)
 * - Session revival (`revivalLease`, the 3-way ready/ack/proceed dance at
 *   predecessor lines 498-509) is a materially different operation - resuming
 *   an existing transcript, not spawning a fresh child - and is not ported.
 *   `session-lease.ts` already exists in this package for whoever builds that
 *   path later
 * - The foreground (synchronous) branch is dropped entirely, per the async-
 *   only requirement below; there is no `async` parameter, only this
 *
 * WHAT THIS DOES NOT BUILD (compose, don't reimplement):
 * `CoalescedStatusWriter`, `TerminalPersistenceService`, `AsyncJobTracker`,
 * `SpawnHandshake`, `ResultWatcher`, `CompletionNotifier` all already exist
 * in this directory and are used here, not reimplemented. In particular, the
 * predecessor's process-exit tracking is reduced to the child handle's exact
 * exit signal: an abnormal exit marks that run failed immediately, while the
 * crash-marker path (`TerminalPersistenceService` +
 * `ProcessTerminalInspector`) remains the recovery path after parent loss.
 * `trackChild(pid)` on the caller's own already-active
 * `TerminalPersistenceService` is what makes a spawned child get killed if
 * the run that spawned it dies, which is the same guarantee the predecessor
 * used its own mechanism for.
 *
 * SDK RUNNER BOUNDARY:
 * `sdkRunnerEntry.ts` is the detached child process target. It reads the
 * launch config, creates the child through Pi's SDK, and loads
 * `subagent-prompt-runtime-entry` as an explicit child extension. That
 * extension owns the handshake, status, steering, and terminal result
 * lifecycle through the existing runner services. The real Pi CLI remains
 * the parent host used by system tests and DoomPi, not the child launcher.
 *
 * WHY SpawnHandshake, NOT `Atomics.wait`:
 * The predecessor blocks the parent's event loop for up to 10 seconds per
 * spawn (`asyncExecution.ts:376-380`, `Atomics.wait` on a shared buffer).
 * That codepath only actually ran for session revival there (a fresh spawn
 * had no `startupPath` and returned immediately) - but this package has no
 * synchronous/foreground path left to hide the cost behind, so a busy-wait
 * would block every single async spawn, not just revivals. `SpawnHandshake`
 * (already in this directory) replaces it: a real `fs.watch` on the
 * handshake file's directory, with a short poll as the safety net, and it
 * never blocks the event loop.
 *
 * LAUNCH CONFIG FILE LIFECYCLE (fix):
 * The predecessor writes the launch config with `fs.writeFileSync(cfgPath,
 * ...)` - no `mode` option, so it lands at the umask default - and never
 * unlinks it on any path, successful or failed
 * (`asyncExecution.ts:491-495`). Both are fixed here: `writeLaunchConfig`
 * writes 0600 (`writePrivateAtomicJson`, already in this package), and
 * `removeLaunchConfig` runs on every exit path - success (once the handshake
 * confirms the child has read it), and every failure (no pid, spawn error,
 * handshake failure or timeout) - so nothing is ever left behind holding the
 * full task text and resolved secrets/tokens at world-readable-adjacent
 * permissions.
 *
 * CHILD INDEX (fix - `DeliverableGuard` had no way to get one):
 * `DeliverableGuard.deliverNudge` requires an explicit `nudgeTarget` of
 * `{kind:'child', index}` for a fan-out run specifically so it cannot
 * broadcast a nudge to every sibling over one child's missing deliverable
 * (see that module's header). Nothing in this package maps a team member id
 * to a fan-out child index (verified: neither `nativeTeamChannel.ts` nor
 * `parallel-groups.ts` does this). This module needs no such mapping either
 * - `childIndex` is simply which spawn call this is, a fact the caller (a
 * single spawn, or a fan-out loop calling this once per child) already knows
 * without looking anything up, exactly like a flat index into
 * `status.steps[]` is decided by whoever builds that array. `nudgeTarget` is
 * derived from `childIndex`/`fanout` and persisted onto the run's own
 * `status.json` (`nudgeTarget` field) for whatever later evaluates
 * `DeliverableGuardInput` to read back, rather than re-derived at that point.
 *
 * DELIVERABLE EXPECTATION (fix - `DeliverableGuard` had no policy):
 * Derived here, at the one point this module already has the task text:
 * `classifyTaskMutationIntent` (used AS-IS, per its own header's warning
 * against widening its vocabulary for a third caller) distinguishes
 * `'implementation'` intent from `'read-only'`/`'unknown'`. Implementation
 * intent gets a real expectation (`{kind:'summary'}` by default - the
 * minimum a run can be asked to prove it did something, when no more
 * specific expectation like a structured-output schema or artifact path was
 * supplied); read-only or unknown intent gets none at all. This is
 * deliberately NOT `{kind:'summary'}` unconditionally: a guard that flags
 * every research run for an empty summary gets ignored, and an ignored guard
 * misses the run that actually needed it.
 *
 * TEAM MEMBERSHIP ENV FORWARDING (fix - a spawned child had no way to join
 * the team):
 * If THIS process (the one calling `spawn()`) is itself part of a native
 * team - `readNativeTeamRootFromEnvironment()` resolves a root context off
 * its own `process.env` - the same root vars
 * (`nativeTeamRootEnvironment(root)`, already in `nativeTeamChannel.ts`,
 * not reimplemented here) are folded into the child's env alongside
 * whatever `buildPiArgs` produced. Only the ROOT vars travel this way, never
 * a member id/token: those are per-member secrets the CHILD mints for
 * itself when it registers (see `runnerBootstrap.ts` and
 * `runnerTeamMembership.ts`), not something safe to hand down from the
 * parent's own identity. When this process has no team root (a standalone
 * spawn outside any team), nothing is forwarded and the child simply has
 * none to register against.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarnessSession, getHarnessState } from '@agimon-ai/doompi-config';
import { DOOMPI_EXTENSIONS_PROVIDED_ENV } from '@agimon-ai/doompi-extension-contracts/child-process';
import type { InlineAgent } from '@agimon-ai/doompi-extension-contracts/subagent-tool';
import {
  PI_RUNTIME_NAME,
  SUBAGENT_RUN_ID_ENV,
  SUBAGENT_TEAM_MEMBER_ID_ENV,
  SUBAGENT_TEAM_MEMBER_TOKEN_ENV,
} from '../../../types/environment';
import { getArtifactPaths, getArtifactsDir } from '../../filesystem/artifacts';
import { writePrivateAtomicJson } from '../../atomicJson';
import {
  currentResultsDir,
  currentRunConfigPath,
  currentRunsDir,
  requireCurrentSessionScope,
  sessionScopeEnvironment,
} from '../../filesystem/paths';
import type { ActivityState, ArtifactDirPreference } from '../../../types';
import {
  nativeTeamRootEnvironment,
  readNativeTeamRootFromEnvironment,
  type TeamRootContext,
} from '../../intercom/nativeTeamChannel';
import { steerAcksDir, steerCapabilityPath, stepSteerInboxDir } from '../../intercom/supervisorControlChannel';
import { registerRun, releaseRun } from '../../runRegistry';
import {
  CLAUDE_FABLE_PROFILE,
  type ClaudeFableLaunch,
  cleanupClaudeFableLaunch,
  prepareClaudeFableLaunch,
} from '../shared/claudeFableProfile';
import { type BuildPiArgsInput, type BuildPiArgsResult, buildPiArgs, type PiSdkLaunchSettings } from '../shared/piArgs';
import { isPiRuntime, type RuntimeTable, resolveRuntimeLaunch } from '../shared/runtimeRegistry';
import { type AsyncJobTrackerContract, TERMINAL_ASYNC_JOB_STATES } from '../../asyncJobTracker';
import { type SpawnHandshakeContract, SpawnHandshake } from './spawnHandshake';
import {
  CoalescedStatusWriter,
  type CoalescedStatusWriterContract,
  STATUS_FILE_NAME,
  type StatusWithRecentEntries,
} from './statusWriter';
import type { TerminalPersistenceContract } from './terminalPersistence';

/** Leaf name of the started-signal file `SpawnHandshake` watches for, under `currentRunsDir()/<runId>/`. Exported so the child-side runner can compose the same convention rather than duplicate it. */
export const HANDSHAKE_FILE_NAME = 'handshake.json';
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
const SYSTEM_PROMPT_FILE_MODE = 0o600;
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
  /** Most recently started child tool. */
  currentTool?: string;
  /** Number of child tool executions observed so far. */
  toolCount?: number;
}

/** The parent-written contract a child-side runner reads via `currentRunConfigPath(runId)`. */
export interface LaunchConfig {
  runId: string;
  agent: string;
  task: string;
  cwd: string;
  childIndex: number;
  handshakePath: string;
  sdk: PiSdkLaunchSettings;
  transcriptPath?: string;
  /** Retained during the SDK cutover for compatibility diagnostics only. */
  args: string[];
  env: Record<string, string | undefined>;
}

export interface AsyncSubagentSpawnInput {
  runId: string;
  operationId?: string;
  agent: string;
  /** One-shot agent definition retained only for explicit suspension restore. */
  inlineAgent?: InlineAgent;
  task: string;
  cwd: string;
  /** Persisted parent transcript used to place child artifacts beside the parent session. */
  parentSessionFile?: string;
  /** This spawn's position among its siblings. 0 for a standalone (non-fan-out) run. */
  childIndex: number;
  /** Whether this spawn is one of several children under a fan-out parent. */
  fanout: boolean;
  /** Everything `buildPiArgs` needs, minus what this spawner supplies itself (`runId`/`task`/`childIndex`). */
  piArgs: Omit<BuildPiArgsInput, 'runId' | 'task' | 'childIndex'>;
  /** False disables the child event transcript. Defaults to enabled. */
  artifacts?: boolean;
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
  /** Prevent sensitive task text from being persisted in status.json. */
  sensitiveTask?: boolean;
  /** Suppress the generic completion notifier for an internal bridge run. */
  internal?: boolean;
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

/** `currentRunsDir()/<runId>`. Exported so the child-side runner resolves the same directory, not a parallel one. */
export function runDirFor(runId: string): string {
  return path.join(currentRunsDir(), runId);
}

/** Exported so the child-side runner writes its ready/error signal at the exact path this parent half waits on. */
export function handshakePathFor(runId: string): string {
  return path.join(runDirFor(runId), HANDSHAKE_FILE_NAME);
}

export function fableProfileResultPathFor(runId: string): string {
  return path.join(runDirFor(runId), FABLE_PROFILE_RESULT_FILE_NAME);
}

/** Where `spawn()` records this run's effective system prompt. See `SYSTEM_PROMPT_FILE_NAME`. */
export function systemPromptPathFor(runId: string): string {
  return path.join(runDirFor(runId), SYSTEM_PROMPT_FILE_NAME);
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

function resolveSdkRunnerEntry(): string {
  return resolveRunnerEntry('runs/sdkRunnerEntry', 'adapters/process/sdkRunnerEntry', 'sdkRunnerEntry');
}

function resolveCliRunnerEntry(): string {
  return resolveRunnerEntry(
    'runs/background/cliRunnerEntry',
    'adapters/runs/background/cliRunnerEntry',
    'cliRunnerEntry',
  );
}

export class AsyncSubagentSpawner implements AsyncSubagentSpawnerContract {
  constructor(
    private readonly jobTracker: AsyncJobTrackerContract,
    private readonly terminalPersistence: TerminalPersistenceContract,
  ) {}

  /**
   * Runtime tuning seam for tests, kept out of the dependency constructor.
   */
  protected readonly defaultHandshakeTimeoutMs: number = DEFAULT_HANDSHAKE_TIMEOUT_MS;

  protected now(): number {
    return Date.now();
  }

  /**
   * This process's own team root context, read fresh per spawn. Protected
   * so a test can supply one without writing real team files to disk - see
   * the module header's TEAM MEMBERSHIP ENV FORWARDING section for why this
   * is read from `process.env` rather than captured in the object graph.
   */
  protected readCurrentTeamRoot(): TeamRootContext | undefined {
    return readNativeTeamRootFromEnvironment();
  }

  /**
   * A fresh writer per spawn, deliberately never the container's shared
   * singleton - the same reasoning as `StaleRunReconciler.createStatusWriter`
   * (see that class's header): the singleton may simultaneously be the live
   * write path for a run THIS process is itself running, and bootstrapping
   * someone else's (the spawned child's) initial status is a different
   * writer's job.
   */
  protected createStatusWriter(): CoalescedStatusWriterContract<AsyncRunStatus> {
    return new CoalescedStatusWriter<AsyncRunStatus>();
  }

  /**
   * A fresh handshake wait per spawn. `SpawnHandshake` is bound transient in
   * the container for exactly this reason (each `waitForHandshake()` owns
   * its own timers and watcher for exactly one spawn); resolving it via
   * constructor injection would hand every spawn the same, already-used
   * instance, so this seam constructs one directly instead.
   */
  protected createSpawnHandshake(): SpawnHandshakeContract {
    return new SpawnHandshake();
  }

  protected writeLaunchConfig(filePath: string, config: object): void {
    writePrivateAtomicJson(filePath, config);
  }

  protected removeLaunchConfig(filePath: string): void {
    fs.rmSync(filePath, { force: true });
  }

  protected readRunState(runId: string): string | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(runDirFor(runId), STATUS_FILE_NAME), 'utf8')) as {
        state?: unknown;
      };
      return typeof parsed.state === 'string' ? parsed.state : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolves the child's CLI args/env. Protected so a test can bypass
   * `buildPiArgs`'s own real filesystem resolution (it locates a runtime
   * extension script on disk via `resolvePiLaunchToolPlan`, which is
   * environment-dependent and not something a unit test for THIS module's
   * orchestration logic should depend on).
   */
  protected buildLaunchArgs(input: BuildPiArgsInput): BuildPiArgsResult {
    return buildPiArgs(input);
  }

  /**
   * The actual `child_process.spawn`. Detached and unref'd immediately. Output
   * goes to per-run files so a startup failure is diagnosable without keeping
   * parent-owned pipes alive.
   */
  protected spawnChild(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ): {
    pid: number | undefined;
    onError: (handler: (error: Error) => void) => void;
    onExit: (handler: (code: number | null, signal: NodeJS.Signals | null) => void) => void;
  } {
    const runId = options.env[SUBAGENT_RUN_ID_ENV];
    let stdoutFd: number | undefined;
    let stderrFd: number | undefined;
    if (runId) {
      const runDir = runDirFor(runId);
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
        stdio: ['ignore', stdoutFd ?? 'ignore', stderrFd ?? 'ignore'],
        windowsHide: true,
        env: options.env,
      });
    } finally {
      if (stdoutFd !== undefined) fs.closeSync(stdoutFd);
      if (stderrFd !== undefined) fs.closeSync(stderrFd);
    }
    child.unref();
    return {
      pid: child.pid,
      onError: (handler) => child.on('error', handler),
      onExit: (handler) => child.on('exit', handler),
    };
  }

  async spawn(input: AsyncSubagentSpawnInput): Promise<AsyncSubagentSpawnResult> {
    const { runId, agent, task, cwd } = input;
    const fanoutIndex = input.fanout ? input.childIndex : undefined;
    const handshakePath = handshakePathFor(runId);
    const configPath = currentRunConfigPath(runId);
    const transcriptPath =
      input.artifacts === false
        ? undefined
        : getArtifactPaths(
            getArtifactsDir(input.parentSessionFile ?? null, cwd, input.artifactDir ?? 'session'),
            runId,
            agent,
          ).transcriptPath;

    const runDir = runDirFor(runId);
    const steerIndex = input.childIndex ?? 0;
    const teamRoot = this.readCurrentTeamRoot();
    const {
      args,
      env: builtEnv,
      sdk,
    } = this.buildLaunchArgs({
      ...input.piArgs,
      runId,
      task,
      childIndex: input.childIndex,
      steerInboxDir: stepSteerInboxDir(runDir, steerIndex),
      steerCapabilityPath: steerCapabilityPath(runDir, steerIndex),
      steerAckDir: steerAcksDir(runDir, steerIndex),
      teamToolEnabled: Boolean(teamRoot),
    });
    // The child gets its own harness state, in this run's directory, which this
    // package owns. Sharing the parent's file would let a detached child rewrite
    // a session it does not own, and pointing at the parent's directory would
    // lose the file the moment the parent cleaned up its own session: a child
    // is detached and can outlive it. Pi 0.84 SDK launches consume the resolved
    // extension list directly, so preserve that same list in the child harness
    // snapshot instead of projecting the parent's stale childExtensions value.
    const parentHarness = getHarnessState();
    createHarnessSession(
      {
        ...parentHarness,
        childExtensions: sdk.extensions,
        ...(parentHarness.mcpProjection
          ? {
              mcpProjection: {
                ...parentHarness.mcpProjection,
                stagingDirectory: runDir,
              },
            }
          : {}),
      },
      { directory: runDir, environment: builtEnv, unclaimed: true },
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...builtEnv,
      // The child resolves the same filesystem tree from this, independently of
      // whether it also joins a team.
      ...sessionScopeEnvironment(requireCurrentSessionScope()),
      ...(teamRoot ? nativeTeamRootEnvironment(teamRoot) : {}),
    };
    // Each child mints its own Team member identity. Never inherit these parent-owned values.
    delete env[SUBAGENT_TEAM_MEMBER_ID_ENV];
    delete env[SUBAGENT_TEAM_MEMBER_TOKEN_ENV];
    if (isPiRuntime(input.runtime)) {
      if (sdk.extensionsProvidedExternally) env[DOOMPI_EXTENSIONS_PROVIDED_ENV] = '1';
      else delete env[DOOMPI_EXTENSIONS_PROVIDED_ENV];
    }

    // Recorded before open() so the status never advertises a sidecar that is
    // not on disk yet. A failure here is not worth failing a spawn over: the
    // prompt is an inspection aid, so the run proceeds without it.
    let systemPromptPath: string | undefined;
    if (isPiRuntime(input.runtime) && sdk.systemPrompt) {
      try {
        fs.mkdirSync(runDir, { recursive: true });
        const target = systemPromptPathFor(runId);
        fs.writeFileSync(target, sdk.systemPrompt, { mode: SYSTEM_PROMPT_FILE_MODE });
        systemPromptPath = target;
      } catch {
        systemPromptPath = undefined;
      }
    }

    const now = this.now();
    const statusWriter = this.createStatusWriter();
    statusWriter.open(runId, {
      version: 1,
      runId,
      ...(input.operationId ? { operationId: input.operationId } : {}),
      agent,
      ...(input.sensitiveTask ? {} : { task }),
      cwd,
      ...(input.piArgs.model ? { model: input.piArgs.model } : {}),
      ...(input.inlineAgent ? { inlineAgent: input.inlineAgent } : {}),
      state: 'queued',
      startedAt: now,
      lastUpdate: now,
      ...(fanoutIndex === undefined ? {} : { fanoutIndex }),
      ...(input.internal ? { internal: true } : {}),
      ...(isPiRuntime(input.runtime) ? {} : { runtime: input.runtime }),
      ...(transcriptPath ? { transcriptPath } : {}),
      ...(systemPromptPath ? { systemPromptPath } : {}),
      ...(systemPromptPath && sdk.systemPromptMode ? { systemPromptMode: sdk.systemPromptMode } : {}),
      ...(sdk.tools ? { tools: sdk.tools } : {}),
      ...(sdk.excludeTools?.length ? { excludeTools: sdk.excludeTools } : {}),
      ...(sdk.noTools ? { noTools: true } : {}),
    });

    if (isPiRuntime(input.runtime)) {
      this.writeLaunchConfig(configPath, {
        runId,
        agent,
        task,
        cwd,
        childIndex: input.childIndex,
        handshakePath,
        sdk,
        ...(transcriptPath ? { transcriptPath } : {}),
        args,
        env,
      });
    }

    let fableLaunch: ClaudeFableLaunch | undefined;
    const fail = (message: string): never => {
      this.removeLaunchConfig(configPath);
      if (fableLaunch) cleanupClaudeFableLaunch(fableLaunch);
      fs.rmSync(fableProfileResultPathFor(runId), { force: true });
      statusWriter.updateSync((status) => {
        status.state = 'failed';
        status.error = message;
        status.lastUpdate = this.now();
      });
      throw new Error(message);
    };

    // One branch, and only one: `pi` runs in-process through the SDK runner and
    // gets the team channel, steering and structured output that go with it.
    // Every other runtime is an external CLI, spawned through the generic
    // runner, which deliberately knows nothing about the vendor.
    const usePi = isPiRuntime(input.runtime);
    if (!usePi) {
      const ceiling = input.piArgs.capabilityCeiling;
      if (ceiling && (!input.externalProfile || !ceiling.allowedExternalProfiles.includes(input.externalProfile))) {
        return fail(
          `External profile '${input.externalProfile ?? 'none'}' is denied by the active capability ceiling.`,
        );
      }
      if (input.externalProfile !== undefined && input.externalProfile !== CLAUDE_FABLE_PROFILE) {
        return fail(`External profile '${input.externalProfile}' is not trusted.`);
      }
      if (input.externalProfile === CLAUDE_FABLE_PROFILE) {
        if (input.runtime !== 'claude' || input.piArgs.model !== 'fable') {
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
        this.writeLaunchConfig(configPath, {
          runId,
          ...(input.operationId ? { operationId: input.operationId } : {}),
          agent,
          runtime: 'claude',
          command: fableLaunch.command,
          args: fableLaunch.args,
          cwd: fableLaunch.cwd,
          env: fableLaunch.env,
          profile: fableLaunch.profile,
          stdinPath: fableLaunch.stdinPath,
          cleanupPaths: fableLaunch.cleanupPaths,
          profileResultPath: fableProfileResultPathFor(runId),
          internal: input.internal === true,
          handshakePath,
          resultPath: path.join(currentResultsDir(), `${runId}.json`),
        });
      } else {
        this.writeLaunchConfig(configPath, {
          runId,
          ...(input.operationId ? { operationId: input.operationId } : {}),
          agent,
          ...resolveRuntimeLaunch(input.runtime as string, input.runtimes ?? {}, {
            prompt: task,
            model: input.piArgs.model,
            cwd,
          }),
          cwd,
          env: builtEnv as Record<string, string>,
          handshakePath,
          resultPath: path.join(currentResultsDir(), `${runId}.json`),
        });
      }
    }

    const { pid, onError, onExit } = this.spawnChild(
      process.execPath,
      [usePi ? resolveSdkRunnerEntry() : resolveCliRunnerEntry()],
      { cwd, env: env as NodeJS.ProcessEnv },
    );
    if (pid === undefined) {
      return fail(`Async spawn for '${agent}' (run '${runId}') did not produce a pid.`);
    }
    let spawnError: Error | undefined;
    onError((error) => {
      spawnError = error;
    });

    // Recorded before the handshake: a parent that dies between spawn and
    // handshake must still leave a record a later sweep can act on.
    registerRun(requireCurrentSessionScope(), {
      runId,
      pid,
      agent,
      runtime: input.runtime ?? PI_RUNTIME_NAME,
      startedAt: now,
    });
    this.terminalPersistence.trackChild(pid);
    onExit((code, signal) => {
      this.terminalPersistence.untrackChild(pid);
      releaseRun(requireCurrentSessionScope(), runId);
      if (code === 0 && signal === null) return;
      statusWriter.updateSync((status) => {
        if (status.state && TERMINAL_ASYNC_JOB_STATES.has(status.state)) return;
        status.state = 'failed';
        status.error = `SDK runner process ${pid} exited unexpectedly (${signal ?? `code ${code ?? 'unknown'}`}).`;
        status.lastUpdate = this.now();
        status.endedAt = this.now();
      });
      this.jobTracker.track(runId);
    });

    const handshake = this.createSpawnHandshake();
    const outcome = await handshake.waitForHandshake({
      path: handshakePath,
      timeoutMs: input.handshakeTimeoutMs ?? this.defaultHandshakeTimeoutMs,
    }).promise;

    if (outcome.status !== 'signalled') {
      this.terminalPersistence.untrackChild(pid);
      const message =
        outcome.status === 'failed'
          ? outcome.error
          : (spawnError?.message ?? `Timed out waiting for '${agent}' (run '${runId}') to start.`);
      return fail(message);
    }

    // The child has confirmed it read the launch config; the parent's copy
    // is no longer needed (see the module header's LAUNCH CONFIG FILE
    // LIFECYCLE section).
    this.removeLaunchConfig(configPath);
    const observedState = this.readRunState(runId);
    if (!observedState || !TERMINAL_ASYNC_JOB_STATES.has(observedState)) {
      statusWriter.updateSync((status) => {
        status.state = 'running';
        status.lastUpdate = this.now();
      });
    }
    this.jobTracker.track(runId);

    return { runId, pid };
  }
}
