import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createDoomTelemetry } from '@agimon-ai/doompi-telemetry';
import { LIFELINE_ENV, watchOwner } from '../adapters/Lifeline/client.ts';

interface CommandSpec {
  command: string;
  cwd: string;
  env: Record<string, string>;
}

const POLL_MS = 10;
const FORWARDED_SIGNAL_GRACE_MS = 2_000;
const HOST_FAILED_EVENT = 'doom_runner.host_failed';
const INVALID_COMMAND_SPEC_ERROR = 'invalid runner command spec';

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const startedAt = Date.now();
  const telemetry = createDoomTelemetry({
    serviceName: 'doom-runner-host',
    packageName: '@agimon-ai/doompi-runner',
    env: process.env,
    enableLogs: true,
    enableTraces: true,
  });
  const [specPath, gatePath, exitPath] = argv;
  let spec: CommandSpec;
  try {
    if (!specPath || !gatePath || !exitPath) throw new Error('runnerHost requires spec, gate, and exit paths');
    spec = readSpec(specPath);
    await waitForGate(gatePath);
  } catch (error) {
    await telemetry.recordError(HOST_FAILED_EVENT, error, { duration_ms: Date.now() - startedAt });
    await telemetry.shutdown();
    throw error;
  }
  let child: ChildProcess | undefined;
  let forwardedSignal: NodeJS.Signals | null = null;
  let escalationTimer: NodeJS.Timeout | undefined;
  const signalChild = (signal: NodeJS.Signals): void => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  const forward = (signal: NodeJS.Signals): void => {
    forwardedSignal = signal;
    signalChild(signal);
    escalationTimer ??= setTimeout(() => signalChild('SIGKILL'), FORWARDED_SIGNAL_GRACE_MS);
  };
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  for (const signal of signals) process.once(signal, () => forward(signal));

  child = spawn(spec.command, {
    cwd: spec.cwd,
    env: spec.env,
    shell: '/bin/bash',
    stdio: 'inherit',
    detached: true,
  });
  if (forwardedSignal) forward(forwardedSignal);

  // This process supervises the command for its whole life, so it is also the
  // right place to notice an owner that died without stopping it.
  //
  // The lifeline comes from the spec rather than this process's environment: an
  // rmux server outlives the session that started it, so its own environment can
  // still name a previous session's socket.
  const detachLifeline = watchOwner(() => forward('SIGTERM'), spec.env[LIFELINE_ENV]);

  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child?.once('error', reject);
      child?.once('exit', (code, signal) => resolve({ code, signal: signal ?? forwardedSignal }));
    });
    writeAtomic(exitPath, result);
    const exitCode = result.code !== null ? result.code : result.signal ? 128 + os.constants.signals[result.signal] : 1;
    await telemetry.recordEvent('doom_runner.host_finished', {
      outcome: result.signal || forwardedSignal ? 'signaled' : exitCode === 0 ? 'completed' : 'failed',
      'runner.exit_code': exitCode,
      ...(result.signal || forwardedSignal ? { 'runner.signal': result.signal ?? forwardedSignal ?? '' } : {}),
      duration_ms: Date.now() - startedAt,
    });
    return exitCode;
  } catch (error) {
    await telemetry.recordError(HOST_FAILED_EVENT, error, { duration_ms: Date.now() - startedAt });
    throw error;
  } finally {
    detachLifeline();
    if (escalationTimer) clearTimeout(escalationTimer);
    await telemetry.shutdown();
  }
}

function readSpec(target: string): CommandSpec {
  const value: unknown = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (typeof value !== 'object' || value === null) throw new Error(INVALID_COMMAND_SPEC_ERROR);
  const spec = value as Partial<CommandSpec>;
  if (typeof spec.command !== 'string' || typeof spec.cwd !== 'string' || !spec.env) {
    throw new Error(INVALID_COMMAND_SPEC_ERROR);
  }
  return { command: spec.command, cwd: spec.cwd, env: spec.env };
}

async function waitForGate(target: string): Promise<void> {
  while (!fs.existsSync(target)) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

function writeAtomic(target: string, value: unknown): void {
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
