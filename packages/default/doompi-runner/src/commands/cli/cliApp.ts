import fs from 'node:fs';
import type { ILauncher } from '../../types/launcher';
import type { ILogReader } from '../../types/logReader';
import type { IRmuxBackend } from '../../types/rmuxBackend';
import type { IRunnerRegistry, RunnerRecord } from '../../types/runnerRegistry';
import { inheritedSessionId, requiredSessionId } from '../../services/runs/session.ts';
import { formatRunnerLine } from '../bash/responseEnvelope.ts';

const DEFAULT_LOG_LINES = 200;
const FOLLOW_INTERVAL_MS = 250;
const COMPLETED_STATE = 'completed';
const MULTIPLEXER_BACKENDS = new Set(['rmux', 'tmux']);
const STOPPED_REASON = 'stopped';
const TERMINATION_SIGNAL = 'SIGTERM';

export interface CliDependencies {
  registry: IRunnerRegistry;
  launcher: ILauncher;
  rmuxBackend: IRmuxBackend;
  logReader: ILogReader;
  env?: NodeJS.ProcessEnv;
  stdout(text: string): void;
  stderr(text: string): void;
  readStdin(): Promise<string>;
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies): Promise<number> {
  const [command, ...args] = argv;
  if (command !== undefined && command !== '--help' && command !== '-h' && !inheritedSessionId(dependencies.env)) {
    dependencies.stderr('PI_SESSION_ID is required for doom-runner commands');
    return 1;
  }
  switch (command) {
    case 'list':
      return list(args, dependencies);
    case 'status':
      return status(args, dependencies);
    case 'logs':
      return logs(args, dependencies);
    case 'stop':
      return stop(args, dependencies);
    case 'stop-all':
      return stopAll(args, dependencies);
    case 'input':
      return input(args, dependencies);
    case '--help':
    case '-h':
    case undefined:
      dependencies.stdout(help());
      return 0;
    default:
      dependencies.stderr(`Unknown command: ${command}\n\n${help()}`);
      return 1;
  }
}

async function list(args: readonly string[], dependencies: CliDependencies): Promise<number> {
  const sessionId = requiredSessionId(dependencies.env);
  const records = args.includes('--all')
    ? await dependencies.registry.listAll(sessionId)
    : await dependencies.registry.listBySession(sessionId);
  dependencies.stdout(records.length > 0 ? records.map(formatRecord).join('\n') : 'No runners');
  return 0;
}

async function status(args: readonly string[], dependencies: CliDependencies): Promise<number> {
  const record = await requiredRecord(args[0], dependencies);
  if (!record) return 1;
  dependencies.stdout(
    [
      `ID: ${record.id}`,
      `Name: ${record.name}`,
      `State: ${record.state}`,
      `Backend: ${record.backend}`,
      ...(record.backendTarget ? [`Backend target: ${record.backendTarget}`] : []),
      `PID: ${record.pid}`,
      `Command: ${record.command}`,
      `CWD: ${record.cwd}`,
      `Session: ${record.sessionId}`,
      `Log: ${record.logPath}`,
      ...(record.exit ? [`Exit: ${formatExit(record)}`] : []),
    ].join('\n'),
  );
  return 0;
}

async function logs(args: readonly string[], dependencies: CliDependencies): Promise<number> {
  const record = await requiredRecord(args[0], dependencies);
  if (!record) return 1;
  const lines = positiveInteger(option(args, '--lines')) ?? DEFAULT_LOG_LINES;
  const result = dependencies.logReader.read(record.logPath, { lines });
  if (!result.exists) {
    dependencies.stderr(`Runner ${record.id} has not written a log yet`);
    return 1;
  }
  if (result.text) dependencies.stdout(result.text);
  if (!args.includes('--follow')) return 0;
  return follow(record, result.fileSize, dependencies);
}

async function stop(args: readonly string[], dependencies: CliDependencies): Promise<number> {
  const record = await requiredRecord(args[0], dependencies);
  if (!record) return 1;
  if (record.state !== 'running') {
    dependencies.stderr(`Runner ${record.id} is already ${record.state}`);
    return 1;
  }
  await stopRecord(record, dependencies);
  const reason = option(args, '--reason');
  await dependencies.registry.complete(
    record.id,
    {
      reason: STOPPED_REASON,
      code: null,
      signal: TERMINATION_SIGNAL,
      ...(reason ? { stopReason: reason } : {}),
    },
    record.sessionId,
  );
  dependencies.stdout(`Stopped ${record.id}\nLog: ${record.logPath}`);
  return 0;
}

async function stopAll(args: readonly string[], dependencies: CliDependencies): Promise<number> {
  const sessionId = requiredSessionId(dependencies.env);
  const records = await dependencies.registry.listBySession(sessionId);
  const reason = option(args, '--reason');
  for (const record of records) {
    await stopRecord(record, dependencies);
    await dependencies.registry.complete(
      record.id,
      {
        reason: STOPPED_REASON,
        code: null,
        signal: TERMINATION_SIGNAL,
        ...(reason ? { stopReason: reason } : {}),
      },
      record.sessionId,
    );
  }
  dependencies.stdout(
    records.length > 0
      ? `Stopped ${records.length} runner(s) for session ${sessionId}: ${records.map((record) => record.id).join(', ')}`
      : `No active runners for session ${sessionId}`,
  );
  return 0;
}

async function input(args: readonly string[], dependencies: CliDependencies): Promise<number> {
  const record = await requiredRecord(args[0], dependencies);
  if (!record) return 1;
  if (record.state === COMPLETED_STATE) {
    dependencies.stderr(`Runner ${record.id} is already completed; use doom-runner logs ${record.id}`);
    return 1;
  }
  if (!record.interactive) {
    dependencies.stderr(`Runner ${record.id} was not started with interactive: true`);
    return 1;
  }
  const supplied = option(args, '--text');
  const text = supplied ?? (await dependencies.readStdin());
  const payload = args.includes('--enter') && !text.endsWith('\n') ? `${text}\n` : text;
  if (!MULTIPLEXER_BACKENDS.has(record.backend) || !record.backendTarget) {
    dependencies.stderr(`Runner ${record.id} uses the ${record.backend} backend, which does not expose CLI input`);
    return 1;
  }
  if (!(await dependencies.rmuxBackend.input(record.backendTarget, payload))) {
    dependencies.stderr(`Runner ${record.id} is no longer accepting RMUX input`);
    return 1;
  }
  dependencies.stdout(`Sent input to ${record.id}`);
  return 0;
}

async function requiredRecord(
  id: string | undefined,
  dependencies: CliDependencies,
): Promise<RunnerRecord | undefined> {
  if (!id) {
    dependencies.stderr('A runner ID is required');
    return undefined;
  }
  const sessionId = requiredSessionId(dependencies.env);
  const scopedRecord = await dependencies.registry.get(id, sessionId);
  if (!scopedRecord) {
    dependencies.stderr(`No runner with id ${id}`);
    return undefined;
  }
  return scopedRecord;
}

function formatRecord(record: RunnerRecord): string {
  const active = formatRunnerLine(record);
  return `${record.id}  ${record.state}  ${record.backend}  ${active}`;
}

function formatExit(record: RunnerRecord): string {
  const exit = record.exit;
  if (!exit) return 'unknown';
  const detail = exit.code !== null ? ` code ${exit.code}` : exit.signal ? ` ${exit.signal}` : '';
  const note = exit.stopReason ? ` (${exit.stopReason})` : '';
  return `${exit.reason}${detail}${note}`;
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function follow(record: RunnerRecord, initialSize: number, dependencies: CliDependencies): Promise<number> {
  let offset = initialSize;
  return new Promise<number>((resolve) => {
    let stopped = false;
    let stateTimer: NodeJS.Timeout;
    const listener = (current: fs.Stats): void => {
      if (current.size < offset) offset = 0;
      if (current.size === offset) return;
      const length = current.size - offset;
      const buffer = Buffer.alloc(length);
      const descriptor = fs.openSync(record.logPath, 'r');
      try {
        const bytesRead = fs.readSync(descriptor, buffer, 0, length, offset);
        if (bytesRead > 0) dependencies.stdout(buffer.subarray(0, bytesRead).toString('utf8'));
      } finally {
        fs.closeSync(descriptor);
      }
      offset = current.size;
    };
    const stopFollowing = (): void => {
      if (stopped) return;
      stopped = true;
      try {
        listener(fs.statSync(record.logPath));
      } catch (error) {
        // A missing log file was already reported by the initial read.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          dependencies.stderr(`Runner ${record.id} failed to flush its final log output: ${(error as Error).message}`);
        }
      }
      fs.unwatchFile(record.logPath, listener);
      clearInterval(stateTimer);
      process.off('SIGINT', stopFollowing);
      resolve(0);
    };
    process.once('SIGINT', stopFollowing);
    fs.watchFile(record.logPath, { interval: FOLLOW_INTERVAL_MS }, listener);
    stateTimer = setInterval(() => {
      void dependencies.registry.get(record.id).then((current) => {
        if (current?.state === COMPLETED_STATE) stopFollowing();
      });
    }, FOLLOW_INTERVAL_MS);
  });
}

async function stopRecord(record: RunnerRecord, dependencies: CliDependencies): Promise<boolean> {
  if (MULTIPLEXER_BACKENDS.has(record.backend) && record.backendTarget) {
    return dependencies.rmuxBackend.stop(record.backendTarget, record.pid);
  }
  return dependencies.launcher.stop(record.pid);
}

function help(): string {
  return [
    'Usage: doom-runner <command>',
    '',
    'Commands:',
    '  list [--all]',
    '  status <id>',
    '  logs <id> [--lines N] [--follow]',
    '  stop <id> [--reason <text>]',
    '  stop-all [--reason <text>]',
    '  input <id> [--text <text>] [--enter]',
  ].join('\n');
}
