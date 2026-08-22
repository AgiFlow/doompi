/**
 * The detached child process for an external agent CLI.
 *
 * Counterpart to `sdkRunnerEntry.ts`, which does the same job for the
 * in-process Pi runtime. Both are spawned by `AsyncSubagentSpawner`, both write
 * the same `status.json` and the same terminal result, and both signal the same
 * handshake - so `AsyncJobTracker`, `ResultWatcher`, the fleet view, internal
 * completion monitors, and public `subagent` status handling cannot tell them apart.
 *
 * WHAT AN EXTERNAL CHILD DOES NOT GET, STATED PLAINLY:
 * No intercom, no steering, no structured output. Those
 * are delivered by `subagentPromptRuntime.ts`, which Pi loads in-process into
 * a Pi child; an arbitrary CLI has nowhere to load it. Team package tool
 * exclusions are therefore best effort for external runtimes. An external
 * child is a one-shot worker: it receives a prompt and returns output. Stop and interrupt
 * still work, because they are process-group signals rather than cooperative
 * file requests.
 *
 * WHY THE OUTPUT IS RECORDED, NOT PARSED:
 * A generic runner cannot know what a given CLI's output means. Trailing stdout
 * is the result; anything more specific would either be wrong for a CLI nobody
 * tested or lock the config to the two that were.
 *
 * AVOID:
 * - Vendor-specific parsing here. If a runtime needs it, that is a different
 *   module and a deliberate decision
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

import { createDoomTelemetry, type DoomTelemetry } from '@agimon-ai/doompi-telemetry';
import { SUBAGENT_ROOT_SESSION_ENV, SUBAGENT_RUN_ID_ENV } from '../../../types/environment';
import { writeAtomicJson, writePrivateAtomicJson } from '../../atomicJson';
import { adoptSessionScopeFromEnv, currentRunConfigPath } from '../../filesystem/paths';
import { CLAUDE_FABLE_PROFILE, cleanupClaudeFableLaunch, parseClaudeFableOutput } from '../shared/claudeFableProfile';
import type { AsyncRunStatus } from './asyncExecution';
import type { CliLaunchConfig } from './cliLaunchConfig';
import { startParentWatchdog } from './parentWatchdog';
import { readAsyncRunStatus } from '../../statusReader';
import { CoalescedStatusWriter } from './statusWriter';

/** How much trailing stdout is kept as the run's result. */
const MAX_RESULT_BYTES = 64 * 1024;
/** How much stderr is kept for a failure message. */
const MAX_STDERR_BYTES = 8 * 1024;
const PARENT_LOST_MESSAGE = 'Parent process was lost.';
const FORCE_KILL_SIGNAL: NodeJS.Signals = 'SIGKILL';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLaunchConfig(runId: string): CliLaunchConfig {
  const parsed: unknown = JSON.parse(fs.readFileSync(currentRunConfigPath(runId), 'utf8'));
  if (!isRecord(parsed) || parsed.runId !== runId || typeof parsed.command !== 'string') {
    throw new Error(`CLI launch config for run '${runId}' is invalid.`);
  }
  return parsed as unknown as CliLaunchConfig;
}

/** Keep only a UTF-8-safe trailing value within `limit` bytes, so a chatty CLI cannot exhaust memory. */
function appendBounded(buffer: string, chunk: string, limit: number): string {
  let combined = buffer + chunk;
  while (Buffer.byteLength(combined, 'utf8') > limit && combined.length > 0) {
    const excess = Buffer.byteLength(combined, 'utf8') - limit;
    combined = combined.slice(Math.max(1, Math.ceil(excess / 2)));
  }
  return combined;
}

let childTelemetry: DoomTelemetry | undefined;

async function finishTelemetry(event: string, attributes: Record<string, unknown>, error?: unknown): Promise<void> {
  const telemetry = childTelemetry;
  childTelemetry = undefined;
  if (!telemetry) return;
  if (error === undefined) await telemetry.recordEvent(event, attributes);
  else await telemetry.recordError(event, error, attributes);
  await telemetry.flush();
  await telemetry.shutdown();
}

async function run(): Promise<void> {
  const startedAt = Date.now();
  childTelemetry = createDoomTelemetry({
    serviceName: 'doom-team-cli-child',
    packageName: '@agimon-ai/doompi-team',
    env: process.env,
    enableLogs: true,
    enableTraces: true,
  });
  const runId = process.env[SUBAGENT_RUN_ID_ENV]?.trim();
  if (!runId) throw new Error(`${SUBAGENT_RUN_ID_ENV} is required.`);
  if (!adoptSessionScopeFromEnv()) {
    throw new Error(`${SUBAGENT_ROOT_SESSION_ENV} is required: a child cannot resolve its session scope without it.`);
  }

  let config: CliLaunchConfig | undefined;
  try {
    config = readLaunchConfig(runId);
    // The vendor process emits its own spawn event before the ready handshake
    // is written below. Reading the config alone is not sufficient evidence
    // that the configured executable can start.
  } catch (error) {
    if (config?.handshakePath && !fs.existsSync(config.handshakePath)) {
      writeAtomicJson(config.handshakePath, { state: 'error', error: errorMessage(error) });
    }
    throw error;
  }

  const statusWriter = new CoalescedStatusWriter<AsyncRunStatus>();
  const now = Date.now();
  await childTelemetry?.recordEvent('doom_team.child_started', {
    runtime: config.runtime,
    'agent.name': config.agent,
    outcome: 'started',
  });
  statusWriter.open(
    runId,
    readAsyncRunStatus(runId) ?? {
      version: 1,
      runId,
      ...(config.operationId ? { operationId: config.operationId } : {}),
      agent: config.agent,
      cwd: config.cwd,
      runtime: config.runtime,
      state: 'queued',
      startedAt: now,
      lastUpdate: now,
    },
  );

  const profileLaunch = config.profile === CLAUDE_FABLE_PROFILE;
  if (config.profile !== undefined && !profileLaunch) throw new Error('Untrusted external profile.');
  if (profileLaunch && (!config.stdinPath || !config.profileResultPath)) {
    throw new Error('Fable profile launch config is incomplete.');
  }
  const stdinFd = profileLaunch ? fs.openSync(config.stdinPath!, 'r') : undefined;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: profileLaunch ? config.env : { ...process.env, ...config.env },
      stdio: [stdinFd ?? 'ignore', 'pipe', 'pipe'],
      // Its own group, so the watchdog below can take the CLI and anything it
      // spawned down together.
      detached: true,
      windowsHide: true,
    });
  } catch (error) {
    if (profileLaunch) {
      cleanupClaudeFableLaunch({ cleanupPaths: config.cleanupPaths ?? [] });
      if (config.profileResultPath) fs.rmSync(config.profileResultPath, { force: true });
    }
    throw error;
  } finally {
    if (stdinFd !== undefined) fs.closeSync(stdinFd);
  }
  const cleanupProfile = (removeResult: boolean): void => {
    if (!profileLaunch) return;
    cleanupClaudeFableLaunch({ cleanupPaths: config.cleanupPaths ?? [] });
    if (removeResult && config.profileResultPath) fs.rmSync(config.profileResultPath, { force: true });
  };

  let requestedSignal: NodeJS.Signals | undefined;
  const stopVendor = (signal: NodeJS.Signals): void => {
    requestedSignal = signal;
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      process.stderr.write(`[doom-team cli runner] Could not signal vendor process: ${errorMessage(error)}\n`);
    }
  };
  process.once('SIGTERM', stopVendor);
  process.once('SIGINT', stopVendor);

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    writeAtomicJson(config.handshakePath, { state: 'ready' });
    statusWriter.updateSync((status) => {
      status.state = 'running';
      status.activityState = 'working';
      status.lastUpdate = Date.now();
    });
  } catch (error) {
    const message = errorMessage(error);
    writeAtomicJson(config.handshakePath, { state: 'error', error: message });
    statusWriter.updateSync((status) => {
      status.state = 'failed';
      status.error = message;
      status.lastUpdate = Date.now();
      status.endedAt = Date.now();
    });
    writeAtomicJson(config.resultPath, {
      runId,
      ...(config.internal ? { internal: true } : {}),
      ...(config.operationId ? { operationId: config.operationId } : {}),
      agent: config.agent,
      runtime: config.runtime,
      success: false,
      summary: profileLaunch ? 'Fable Claude launch failed.' : message,
    });
    statusWriter.close();
    cleanupProfile(true);
    await finishTelemetry(
      'doom_team.child_failed',
      { runtime: config.runtime, 'agent.name': config.agent, duration_ms: Date.now() - startedAt, outcome: 'failed' },
      error,
    );
    process.exit(1);
  }

  // A SIGKILLed parent cannot signal us, so terminate the vendor tree and
  // persist a terminal record before leaving when the watchdog can observe it.
  const stopWatchdog = startParentWatchdog({
    onParentLost: () => {
      stopVendor(FORCE_KILL_SIGNAL);
      const endedAt = Date.now();
      statusWriter.updateSync((status) => {
        status.state = 'stopped';
        status.error = PARENT_LOST_MESSAGE;
        status.lastUpdate = endedAt;
        status.endedAt = endedAt;
      });
      writeAtomicJson(config.resultPath, {
        runId,
        ...(config.internal ? { internal: true } : {}),
        ...(config.operationId ? { operationId: config.operationId } : {}),
        agent: config.agent,
        runtime: config.runtime,
        success: false,
        summary: PARENT_LOST_MESSAGE,
        signal: FORCE_KILL_SIGNAL,
      });
      statusWriter.close();
      cleanupProfile(true);
      void finishTelemetry('doom_team.child_finished', {
        runtime: config.runtime,
        'agent.name': config.agent,
        duration_ms: Date.now() - startedAt,
        outcome: 'parent_lost',
      }).finally(() => process.exit(0));
    },
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk.toString('utf8'), MAX_RESULT_BYTES);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk.toString('utf8'), MAX_STDERR_BYTES);
  });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolve) => {
    child.on('error', (error) => resolve({ code: null, signal: null, error }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  stopWatchdog();

  const stopped = requestedSignal !== undefined;
  let profileError: Error | undefined;
  if (profileLaunch && !stopped && exit.error === undefined && exit.code === 0) {
    try {
      const parsed = parseClaudeFableOutput(stdout);
      writePrivateAtomicJson(config.profileResultPath!, { text: parsed.text, outputBytes: parsed.outputBytes });
    } catch (error) {
      profileError = error instanceof Error ? error : new Error(String(error));
    }
  }
  const success = !stopped && exit.error === undefined && exit.code === 0 && profileError === undefined;
  const failureDetail = profileLaunch
    ? (profileError?.message ?? 'Fable Claude launch failed.')
    : stderr.trim() || `${config.runtime} exited with ${exit.signal ?? `code ${exit.code ?? 'unknown'}`}.`;
  const summary = stopped
    ? `Stopped by ${requestedSignal}.`
    : success
      ? profileLaunch
        ? 'Fable profile completed.'
        : stdout.trim()
      : (exit.error?.message ?? failureDetail);
  const endedAt = Date.now();

  statusWriter.updateSync((status) => {
    status.state = stopped ? 'stopped' : success ? 'completed' : 'failed';
    status.activityState = 'finalizing';
    status.summary = summary;
    if (!success) status.error = summary;
    status.lastUpdate = endedAt;
    status.endedAt = endedAt;
  });
  writeAtomicJson(config.resultPath, {
    runId,
    ...(config.internal ? { internal: true } : {}),
    ...(config.operationId ? { operationId: config.operationId } : {}),
    agent: config.agent,
    runtime: config.runtime,
    success,
    summary,
    ...(exit.code === null ? {} : { exitCode: exit.code }),
    ...(exit.signal ? { signal: exit.signal } : {}),
  });

  statusWriter.close();
  cleanupProfile(!success);
  await finishTelemetry('doom_team.child_finished', {
    runtime: config.runtime,
    'agent.name': config.agent,
    duration_ms: Date.now() - startedAt,
    'runner.stdout_bytes': Buffer.byteLength(stdout, 'utf8'),
    'runner.stderr_bytes': Buffer.byteLength(stderr, 'utf8'),
    'runner.exit_code': exit.code ?? 0,
    outcome: stopped ? 'stopped' : success ? 'completed' : 'failed',
  });
  // The runner exit code reports transport health. Task success or failure is
  // encoded durably in status and result data before this process exits.
  process.exit(0);
}

void run().catch(async (error: unknown) => {
  await finishTelemetry('doom_team.child_failed', { outcome: 'failed' }, error);
  // Keep stdout reserved for vendor output. Stderr is captured in the run's
  // runner log and makes a transport failure diagnosable by the parent.
  process.stderr.write(`[doom-team cli runner] ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
