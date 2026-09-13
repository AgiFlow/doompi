/**
 * Detached child process for an explicitly selected external agent CLI.
 *
 * Launch, readiness, control, status, and completion use one bounded Node IPC
 * protocol. Durable status and result files are output records only. They are
 * never read to discover live state or coordinate the parent and child.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

import { createDoomTelemetry, type DoomTelemetry } from '@agimon-ai/doompi-telemetry';

import type { AsyncRunStatus } from '../services/asyncExecution';
import { writeAtomicJson, writePrivateAtomicJson } from '../services/atomicJson';
import { CLAUDE_FABLE_PROFILE, cleanupClaudeFableLaunch, parseClaudeFableOutput } from '../services/claudeFableProfile';
import type { CliLaunchConfig } from '../services/cliLaunchConfig';
import {
  EXTERNAL_IPC_CHANNEL,
  EXTERNAL_IPC_VERSION,
  parseExternalParentMessage,
  sendRunnerMessage,
  type ExternalRunProjection,
  type ExternalRunnerMessage,
} from '../services/externalProcessIpc';
import { adoptSessionScopeFromEnv, type SessionScope } from '../services/sessionPaths';
import { CoalescedStatusWriter } from '../services/statusWriter';
import { SUBAGENT_ROOT_SESSION_ENV, SUBAGENT_RUN_ID_ENV } from '../types/environment';

const MAX_RESULT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const LAUNCH_TIMEOUT_MS = 15_000;
const PARENT_LOST_MESSAGE = 'Parent process was lost.';
const FORCE_KILL_SIGNAL: NodeJS.Signals = 'SIGKILL';
const STARTUP_ENVIRONMENT: Readonly<Record<string, string | undefined>> = Object.freeze({ ...process.env });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateLaunchConfig(value: Record<string, unknown>, runId: string): CliLaunchConfig {
  if (
    value.runId !== runId ||
    typeof value.agent !== 'string' ||
    typeof value.task !== 'string' ||
    typeof value.runtime !== 'string' ||
    typeof value.command !== 'string' ||
    !Array.isArray(value.args) ||
    !value.args.every((entry) => typeof entry === 'string') ||
    typeof value.cwd !== 'string' ||
    !isRecord(value.env) ||
    typeof value.resultPath !== 'string'
  ) {
    throw new Error(`CLI launch config for run '${runId}' is invalid.`);
  }
  return value as unknown as CliLaunchConfig;
}

async function receiveLaunchConfig(scope: SessionScope, runId: string): Promise<CliLaunchConfig> {
  return await new Promise<CliLaunchConfig>((resolve, reject) => {
    const finish = (error?: Error, config?: CliLaunchConfig): void => {
      clearTimeout(timer);
      process.off('message', onMessage);
      process.off('disconnect', onDisconnect);
      if (error) reject(error);
      else resolve(config!);
    };
    const onDisconnect = (): void => finish(new Error(PARENT_LOST_MESSAGE));
    const onMessage = (raw: unknown): void => {
      try {
        const message = parseExternalParentMessage(raw, { runId, scopeKey: scope.scopeKey });
        if (!message || message.kind !== 'launch') return;
        finish(undefined, validateLaunchConfig(message.config, runId));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for CLI launch config for run '${runId}'.`)),
      LAUNCH_TIMEOUT_MS,
    );
    timer.unref();
    process.on('message', onMessage);
    process.once('disconnect', onDisconnect);
  });
}

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

function projection(
  config: CliLaunchConfig,
  state: ExternalRunProjection['state'],
  startedAt: number,
  fields: Partial<Pick<ExternalRunProjection, 'summary' | 'error'>> = {},
): ExternalRunProjection {
  return {
    runId: config.runId,
    agent: config.agent,
    task: config.sensitiveTask ? '' : config.task,
    runtime: config.runtime,
    state,
    startedAt,
    updatedAt: Date.now(),
    cwd: config.cwd,
    ...fields,
  };
}

function resultFor(
  config: CliLaunchConfig,
  success: boolean,
  summary: string,
  exit?: { code: number | null; signal: NodeJS.Signals | null },
): Record<string, unknown> {
  return {
    runId: config.runId,
    ...(config.operationId ? { operationId: config.operationId } : {}),
    ...(config.internal ? { internal: true } : {}),
    agent: config.agent,
    runtime: config.runtime,
    success,
    summary,
    ...(exit?.code === null || exit?.code === undefined ? {} : { exitCode: exit.code }),
    ...(exit?.signal ? { signal: exit.signal } : {}),
  };
}

function runnerMessage(
  scope: SessionScope,
  runId: string,
  message:
    | { kind: 'ready' }
    | { kind: 'status'; status: ExternalRunProjection }
    | { kind: 'result'; result: Record<string, unknown> }
    | { kind: 'error'; error: string }
    | { kind: 'ack'; requestId: string; state: 'delivered' | 'failed'; message: string },
): ExternalRunnerMessage {
  const base = {
    channel: EXTERNAL_IPC_CHANNEL,
    version: EXTERNAL_IPC_VERSION,
    direction: 'runner',
    runId,
    scopeKey: scope.scopeKey,
  } as const;
  if (message.kind === 'ack') return { ...base, ...message, command: 'steer' };
  return { ...base, ...message };
}

function send(scope: SessionScope, runId: string, message: Parameters<typeof runnerMessage>[2]): Promise<void> {
  return sendRunnerMessage(runnerMessage(scope, runId, message));
}

async function run(): Promise<void> {
  const startedAt = Date.now();
  const runId = STARTUP_ENVIRONMENT[SUBAGENT_RUN_ID_ENV]?.trim();
  if (!runId) throw new Error(`${SUBAGENT_RUN_ID_ENV} is required.`);
  const scope = adoptSessionScopeFromEnv(STARTUP_ENVIRONMENT);
  if (!scope) {
    throw new Error(`${SUBAGENT_ROOT_SESSION_ENV} is required: a child cannot resolve its session scope without it.`);
  }
  const config = await receiveLaunchConfig(scope, runId);

  childTelemetry = createDoomTelemetry({
    serviceName: 'doom-team-cli-child',
    packageName: '@agimon-ai/doompi-team',
    env: config.env,
    enableLogs: true,
    enableTraces: true,
  });

  const statusWriter = new CoalescedStatusWriter<AsyncRunStatus>();
  statusWriter.open(scope, runId, {
    version: 1,
    runId,
    ...(config.operationId ? { operationId: config.operationId } : {}),
    agent: config.agent,
    ...(config.sensitiveTask ? {} : { task: config.task }),
    cwd: config.cwd,
    runtime: config.runtime,
    state: 'queued',
    startedAt,
    lastUpdate: startedAt,
  });

  await childTelemetry.recordEvent('doom_team.child_started', {
    runtime: config.runtime,
    'agent.name': config.agent,
    outcome: 'started',
  });

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
      env: config.env,
      stdio: [stdinFd ?? 'ignore', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    });
  } finally {
    if (stdinFd !== undefined) fs.closeSync(stdinFd);
  }

  const cleanupProfile = (removeResult: boolean): void => {
    if (!profileLaunch) return;
    cleanupClaudeFableLaunch({ cleanupPaths: config.cleanupPaths ?? [] });
    if (removeResult && config.profileResultPath) fs.rmSync(config.profileResultPath, { force: true });
  };

  let requestedSignal: NodeJS.Signals | undefined;
  let finalizing = false;
  const stopVendor = (signal: NodeJS.Signals): void => {
    requestedSignal = signal;
    if (!child.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      process.stderr.write(`[doom-team cli runner] Could not signal vendor process: ${errorMessage(error)}\n`);
    }
  };
  const onSigterm = (): void => stopVendor('SIGTERM');
  const onSigint = (): void => stopVendor('SIGINT');
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);

  const onControl = (raw: unknown): void => {
    const message = parseExternalParentMessage(raw, { runId, scopeKey: scope.scopeKey });
    if (!message || message.kind !== 'control') return;
    if (message.command === 'steer') {
      void send(scope, runId, {
        kind: 'ack',
        requestId: message.requestId,
        state: 'failed',
        message: `Runtime '${config.runtime}' does not support live steering.`,
      });
      return;
    }
    stopVendor(message.command === 'interrupt' ? 'SIGINT' : 'SIGTERM');
  };
  process.on('message', onControl);

  const onParentLost = (): void => {
    if (finalizing) return;
    finalizing = true;
    stopVendor(FORCE_KILL_SIGNAL);
    const endedAt = Date.now();
    statusWriter.updateSync((status) => {
      status.state = 'stopped';
      status.error = PARENT_LOST_MESSAGE;
      status.lastUpdate = endedAt;
      status.endedAt = endedAt;
    });
    writeAtomicJson(config.resultPath, {
      ...resultFor(config, false, PARENT_LOST_MESSAGE, { code: null, signal: FORCE_KILL_SIGNAL }),
      state: 'stopped',
      ...(config.internal ? { internal: true } : {}),
    });
    statusWriter.close();
    cleanupProfile(true);
    void finishTelemetry('doom_team.child_finished', {
      runtime: config.runtime,
      'agent.name': config.agent,
      duration_ms: Date.now() - startedAt,
      outcome: 'parent_lost',
    }).finally(() => process.exit(0));
  };
  process.once('disconnect', onParentLost);

  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const running = projection(config, 'running', startedAt);
    statusWriter.updateSync((status) => {
      status.state = 'running';
      status.activityState = 'working';
      status.lastUpdate = Date.now();
    });
    await send(scope, runId, { kind: 'status', status: running });
    await send(scope, runId, { kind: 'ready' });
  } catch (error) {
    finalizing = true;
    const message = errorMessage(error);
    const endedAt = Date.now();
    const result = {
      ...resultFor(config, false, profileLaunch ? 'Fable Claude launch failed.' : message),
      state: 'failed',
    };
    statusWriter.updateSync((status) => {
      status.state = 'failed';
      status.error = message;
      status.lastUpdate = endedAt;
      status.endedAt = endedAt;
    });
    writeAtomicJson(config.resultPath, { ...result, ...(config.internal ? { internal: true } : {}) });
    await send(scope, runId, { kind: 'error', error: message });
    await send(scope, runId, { kind: 'result', result });
    statusWriter.close();
    cleanupProfile(true);
    await finishTelemetry(
      'doom_team.child_failed',
      { runtime: config.runtime, 'agent.name': config.agent, duration_ms: Date.now() - startedAt, outcome: 'failed' },
      error,
    );
    process.exit(1);
  }

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
  finalizing = true;
  process.off('message', onControl);
  process.off('disconnect', onParentLost);
  process.off('SIGTERM', onSigterm);
  process.off('SIGINT', onSigint);

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
  const state = stopped ? ('stopped' as const) : success ? ('completed' as const) : ('failed' as const);
  const result = { ...resultFor(config, success, summary, exit), state };

  statusWriter.updateSync((status) => {
    status.state = state;
    status.activityState = 'finalizing';
    status.summary = summary;
    if (!success) status.error = summary;
    status.lastUpdate = endedAt;
    status.endedAt = endedAt;
  });
  writeAtomicJson(config.resultPath, { ...result, ...(config.internal ? { internal: true } : {}) });
  await send(scope, runId, {
    kind: 'status',
    status: projection(config, state, startedAt, {
      summary,
      ...(!success ? { error: summary } : {}),
    }),
  });
  await send(scope, runId, { kind: 'result', result });

  statusWriter.close();
  cleanupProfile(!success);
  await finishTelemetry('doom_team.child_finished', {
    runtime: config.runtime,
    'agent.name': config.agent,
    duration_ms: Date.now() - startedAt,
    'runner.stdout_bytes': Buffer.byteLength(stdout, 'utf8'),
    'runner.stderr_bytes': Buffer.byteLength(stderr, 'utf8'),
    'runner.exit_code': exit.code ?? 0,
    outcome: state,
  });
  process.exit(0);
}

void run().catch(async (error: unknown) => {
  const runId = STARTUP_ENVIRONMENT[SUBAGENT_RUN_ID_ENV]?.trim();
  const scope = adoptSessionScopeFromEnv(STARTUP_ENVIRONMENT);
  if (runId && scope && process.connected) {
    try {
      await send(scope, runId, { kind: 'error', error: errorMessage(error) });
    } catch {
      // The parent channel is already gone, so stderr is the only remaining diagnostic.
    }
  }
  await finishTelemetry('doom_team.child_failed', { outcome: 'failed' }, error);
  process.stderr.write(`[doom-team cli runner] ${errorMessage(error)}\n`);
  process.exitCode = 1;
});
