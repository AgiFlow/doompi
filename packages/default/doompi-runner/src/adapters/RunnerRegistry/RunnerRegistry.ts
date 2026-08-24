import fs from 'node:fs';
import path from 'node:path';
import { resolveRootSessionId } from '@agimon-ai/doompi-extension-contracts/child-process';
import {
  createProcessRegistryService,
  normalizeRepositoryPath,
  type ProcessRegistryRecord,
  type ProcessRegistryService,
  resolveProcessTags,
} from '@agimon-ai/foundation-process-registry';
import type { IProcessControl } from '../../types/processControl';
import type { IRunnerPaths } from '../../services/RunnerPaths/types';
import { isRunnerRecord } from '../../services/runs/runnerRecord.ts';
import type {
  CompleteRunnerInput,
  IRunnerRegistry,
  RegisterRunnerInput,
  RunnerRecord,
} from '../../types/runnerRegistry';

const SERVICE_TYPE = 'tool';
const SERVICE_PREFIX = 'doom-runner:';
const RUNNER_TAG = 'doom-runner';
const REGISTRY_PATH_ENV = 'PROCESS_REGISTRY_PATH';
const JSON_EXTENSION = '.json';
const COMMAND_SIDECAR_SUFFIX = '.command.json';
const EXIT_SIDECAR_SUFFIX = '.exit.json';
const NOT_FOUND_ERROR_CODE = 'ENOENT';

/** The slice of the shared registry service this wrapper depends on. */
export type ProcessRegistryPort = Pick<
  ProcessRegistryService,
  'registerProcess' | 'releaseProcess' | 'listProcesses' | 'close'
>;

/** Opens the SQLite-backed registry the rest of the monorepo already shares. */
export function createDefaultProcessRegistry(): ProcessRegistryPort {
  return createProcessRegistryService(process.env[REGISTRY_PATH_ENV]);
}

function sessionTag(sessionId: string): string {
  return `session:${sessionId}`;
}

function readString(record: ProcessRegistryRecord, key: string): string {
  const value = record.metadata?.[key];
  return typeof value === 'string' ? value : '';
}

function readNumber(record: ProcessRegistryRecord, key: string): number {
  const value = record.metadata?.[key];
  return typeof value === 'number' ? value : 0;
}

export class RunnerRegistry implements IRunnerRegistry {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly paths: IRunnerPaths,
    private readonly processControl: IProcessControl,
    private readonly registry: ProcessRegistryPort,
  ) {}

  async register(input: RegisterRunnerInput): Promise<RunnerRecord> {
    const startedAt = new Date().toISOString();
    const rootSessionId = resolveRootSessionId(input.sessionId);
    const response = await this.registry.registerProcess({
      repositoryPath: this.repositoryPath(),
      serviceName: `${SERVICE_PREFIX}${input.id}`,
      serviceType: SERVICE_TYPE,
      pid: input.pid,
      command: input.command,
      tags: resolveProcessTags([RUNNER_TAG, `runner:${input.id}`, sessionTag(input.sessionId)]),
      metadata: {
        id: input.id,
        name: input.name,
        command: input.command,
        cwd: input.cwd,
        logPath: input.logPath,
        interactive: input.interactive,
        sessionId: input.sessionId,
        rootSessionId,
        backend: input.backend,
        ...(input.backendTarget ? { backendTarget: input.backendTarget } : {}),
        startedAt,
        hostPid: process.pid,
      },
      // The caller has already resolved name collisions against live records,
      // so anything still holding this name is stale.
      force: true,
    });
    if (!response.success) throw new Error(response.error ?? `Failed to register runner ${input.name}`);
    const record: RunnerRecord = {
      id: input.id,
      name: input.name,
      pid: input.pid,
      command: input.command,
      cwd: input.cwd,
      logPath: input.logPath,
      interactive: input.interactive,
      sessionId: input.sessionId,
      rootSessionId,
      startedAt,
      state: 'running',
      promoted: false,
      backend: input.backend,
      ...(input.backendTarget ? { backendTarget: input.backendTarget } : {}),
      ...(input.alarmMs ? { alarm: { intervalMs: input.alarmMs, lastFiredAt: startedAt } } : {}),
      hostPid: process.pid,
    };
    this.writeRecord(record);
    this.notify();
    return record;
  }

  async list(): Promise<RunnerRecord[]> {
    const records = await this.registry.listProcesses({
      repositoryPath: this.repositoryPath(),
      serviceType: SERVICE_TYPE,
      tags: resolveProcessTags([RUNNER_TAG]),
    });
    return records.map(toRunnerRecord);
  }

  async listAcrossRepositories(): Promise<RunnerRecord[]> {
    const records = await this.registry.listProcesses({
      serviceType: SERVICE_TYPE,
      tags: resolveProcessTags([RUNNER_TAG]),
    });
    return records.map(toRunnerRecord);
  }

  async listBySession(sessionId: string): Promise<RunnerRecord[]> {
    const records = await this.list();
    return records.filter((record) => record.sessionId === sessionId);
  }

  async listByRootSession(rootSessionId: string): Promise<RunnerRecord[]> {
    const records = await this.list();
    return records.filter((record) => (record.rootSessionId ?? record.sessionId) === rootSessionId);
  }

  async listAll(sessionId?: string): Promise<RunnerRecord[]> {
    this.paths.ensureDirectories(sessionId);
    const records: RunnerRecord[] = [];
    const directory = this.paths.stateDirectory(sessionId);
    for (const entry of fs.readdirSync(directory)) {
      if (!isPrimaryMetadataEntry(entry)) continue;
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(`${directory}/${entry}`, 'utf8'));
        if (isRunnerRecord(parsed)) records.push(parsed);
      } catch (error) {
        process.emitWarning(`Could not read runner metadata ${entry}: ${String(error)}`);
      }
    }
    return records.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async get(id: string, sessionId?: string): Promise<RunnerRecord | undefined> {
    const target = this.paths.statePathFor(id, sessionId);
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (!isRunnerRecord(parsed) || parsed.id !== id) {
        process.emitWarning(`Could not read runner metadata ${path.basename(target)}: invalid runner record`);
        return undefined;
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === NOT_FOUND_ERROR_CODE) return undefined;
      process.emitWarning(`Could not read runner metadata ${path.basename(target)}: ${String(error)}`);
      return undefined;
    }
  }

  async markPromoted(id: string): Promise<RunnerRecord | undefined> {
    const record = await this.get(id);
    if (!record) return undefined;
    const promoted = { ...record, promoted: true };
    this.writeRecord(promoted);
    this.notify();
    return promoted;
  }

  async clearAlarm(id: string, sessionId?: string): Promise<RunnerRecord | undefined> {
    const record = await this.get(id, sessionId);
    if (!record) return undefined;
    if (!record.alarm) return record;
    const cleared: RunnerRecord = { ...record };
    delete cleared.alarm;
    this.writeRecord(cleared);
    this.notify();
    return cleared;
  }

  async markAlarmFired(id: string, firedAt: string): Promise<RunnerRecord | undefined> {
    const record = await this.get(id);
    if (!record?.alarm || record.state !== 'running') return undefined;
    const fired: RunnerRecord = { ...record, alarm: { ...record.alarm, lastFiredAt: firedAt } };
    this.writeRecord(fired);
    this.notify();
    return fired;
  }

  async complete(id: string, outcome: CompleteRunnerInput, sessionId?: string): Promise<RunnerRecord | undefined> {
    const persisted = await this.get(id, sessionId);
    if (persisted?.state === 'completed') {
      await this.release(id);
      return persisted;
    }
    const active = await this.list();
    const record =
      persisted ??
      active.find((candidate) => candidate.id === id && (sessionId === undefined || candidate.sessionId === sessionId));
    if (!record) {
      const belongsToAnotherSession =
        sessionId !== undefined && active.some((candidate) => candidate.id === id && candidate.sessionId !== sessionId);
      if (!belongsToAnotherSession) await this.release(id);
      return undefined;
    }
    const completed: RunnerRecord = {
      ...record,
      state: 'completed',
      exit: { ...outcome, finishedAt: new Date().toISOString() },
    };
    this.writeRecord(completed);
    await this.release(id);
    return completed;
  }

  async release(id: string): Promise<void> {
    const response = await this.registry.releaseProcess({
      repositoryPath: this.repositoryPath(),
      serviceName: `${SERVICE_PREFIX}${id}`,
      serviceType: SERVICE_TYPE,
      kill: false,
      releasePort: false,
      force: true,
    });
    if (!response.success && !response.error?.includes('No matching process entry')) {
      throw new Error(response.error ?? `Failed to release runner ${id}`);
    }
    this.notify();
  }

  async pruneDead(): Promise<string[]> {
    const dead = (await this.list()).filter((record) => !this.processControl.isAlive(record.pid));
    for (const record of dead) {
      await this.complete(record.id, { reason: 'backend_lost', code: null, signal: null }, record.sessionId);
    }
    return dead.map((record) => record.id);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
    this.registry.close();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private repositoryPath(): string {
    return normalizeRepositoryPath(this.paths.repositoryPath());
  }

  private writeRecord(record: RunnerRecord): void {
    this.paths.ensureDirectories(record.sessionId);
    const target = this.paths.statePathFor(record.id, record.sessionId);
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, target);
  }
}

/** Every field is read back from metadata this class wrote on registration. */
function toRunnerRecord(record: ProcessRegistryRecord): RunnerRecord {
  return {
    id: readString(record, 'id'),
    name: readString(record, 'name'),
    pid: record.pid,
    command: readString(record, 'command'),
    cwd: readString(record, 'cwd'),
    logPath: readString(record, 'logPath'),
    interactive: record.metadata?.interactive === true,
    sessionId: readString(record, 'sessionId'),
    ...(readString(record, 'rootSessionId') ? { rootSessionId: readString(record, 'rootSessionId') } : {}),
    startedAt: readString(record, 'startedAt'),
    state: 'running',
    promoted: false,
    backend: readBackend(record.metadata?.backend),
    ...(readString(record, 'backendTarget') ? { backendTarget: readString(record, 'backendTarget') } : {}),
    hostPid: readNumber(record, 'hostPid'),
  };
}

function readBackend(value: unknown): RunnerRecord['backend'] {
  return value === 'rmux' || value === 'tmux' ? value : 'native';
}

function isPrimaryMetadataEntry(entry: string): boolean {
  return (
    entry.endsWith(JSON_EXTENSION) && !entry.endsWith(COMMAND_SIDECAR_SUFFIX) && !entry.endsWith(EXIT_SIDECAR_SUFFIX)
  );
}
