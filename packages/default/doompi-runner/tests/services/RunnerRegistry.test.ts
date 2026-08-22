import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SUBAGENT_ROOT_SESSION_ENV } from '@agimon-ai/doompi-extension-contracts/child-process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IProcessControl } from '../../src/types/processControl';
import type { IRunnerPaths } from '../../src/services/RunnerPaths/types';
import { RunnerRegistry, createDefaultProcessRegistry } from '../../src/adapters/RunnerRegistry/RunnerRegistry';
import type { ProcessRegistryPort } from '../../src/adapters/RunnerRegistry/RunnerRegistry';

const REGISTRY_PATH_ENV = 'PROCESS_REGISTRY_PATH';
const RETAINED_HISTORY_RECORDS = 500;

let directory: string;
let previousRegistryPath: string | undefined;
let previousRootSession: string | undefined;
const open: RunnerRegistry[] = [];

function pathsFor(repositoryPath: string): IRunnerPaths {
  const stateDirectory = path.join(directory, 'runs');
  return {
    repositoryPath: () => repositoryPath,
    setSessionId: () => undefined,
    logDirectory: () => path.join(repositoryPath, 'logs'),
    logPathFor: (name) => path.join(repositoryPath, 'logs', `${name}.log`),
    rotatedLogPathFor: (name) => path.join(repositoryPath, 'logs', `${name}.log.1`),
    stateDirectory: () => stateDirectory,
    statePathFor: (id) => path.join(stateDirectory, `${id}.json`),
    ensureDirectories: () => fs.mkdirSync(stateDirectory, { recursive: true }),
    sweepHistory: () => ({ removed: [], errors: [] }),
    legacyDirectory: () => undefined,
    removeLegacyStore: () => undefined,
  };
}

function controlWith(alive: ReadonlySet<number>): IProcessControl {
  return { isAlive: (pid) => alive.has(pid), signalGroup: () => true };
}

function registryFor(
  repositoryPath: string,
  alive: ReadonlySet<number> = new Set([1, 2, 3]),
  port: ProcessRegistryPort = createDefaultProcessRegistry(),
): RunnerRegistry {
  const registry = new RunnerRegistry(pathsFor(repositoryPath), controlWith(alive), port);
  open.push(registry);
  return registry;
}

/** A port that reports failure without touching the real registry. */
function failingPort(error: string | undefined): ProcessRegistryPort {
  return {
    registerProcess: async () => ({ success: false, error }),
    releaseProcess: async () => ({ success: false, error }),
    listProcesses: async () => [],
    close: () => undefined,
  };
}

function inputFor(name: string, pid: number, sessionId = 'session-a') {
  return {
    id: name,
    name,
    pid,
    command: `sleep ${pid}`,
    cwd: '/tmp',
    logPath: `/tmp/${name}.log`,
    interactive: false,
    sessionId,
    backend: 'native' as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-runner-registry-')));
  previousRegistryPath = process.env[REGISTRY_PATH_ENV];
  previousRootSession = process.env[SUBAGENT_ROOT_SESSION_ENV];
  process.env[REGISTRY_PATH_ENV] = path.join(directory, 'processes.db');
  delete process.env[SUBAGENT_ROOT_SESSION_ENV];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const registry of open.splice(0)) registry.close();
  if (previousRegistryPath === undefined) delete process.env[REGISTRY_PATH_ENV];
  else process.env[REGISTRY_PATH_ENV] = previousRegistryPath;
  if (previousRootSession === undefined) delete process.env[SUBAGENT_ROOT_SESSION_ENV];
  else process.env[SUBAGENT_ROOT_SESSION_ENV] = previousRootSession;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('RunnerRegistry', () => {
  it('round-trips a runner through the shared registry', async () => {
    const registry = registryFor('/repo/main');
    const registered = await registry.register(inputFor('api', 1));

    expect(registered.name).toBe('api');
    expect(registered.hostPid).toBe(process.pid);

    const found = await registry.get('api');
    expect(found).toMatchObject({
      name: 'api',
      pid: 1,
      command: 'sleep 1',
      cwd: '/tmp',
      logPath: '/tmp/api.log',
      interactive: false,
      sessionId: 'session-a',
    });
  });

  it('reads only the requested primary metadata record with retained history', async () => {
    const registry = registryFor('/repo/main');
    await registry.register(inputFor('api', 1));
    for (let index = 0; index < RETAINED_HISTORY_RECORDS; index += 1) {
      fs.writeFileSync(path.join(directory, 'runs', `unrelated-${index}.json`), '{ invalid json', 'utf8');
    }
    const readFile = vi.spyOn(fs, 'readFileSync');
    const emitWarning = vi.spyOn(process, 'emitWarning');

    await expect(registry.get('api')).resolves.toMatchObject({ id: 'api' });

    const metadataReads = readFile.mock.calls
      .map(([target]) => String(target))
      .filter((target) => target.endsWith('.json'));
    expect(metadataReads).toEqual([path.join(directory, 'runs', 'api.json')]);
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it('ignores command and exit sidecars when listing history', async () => {
    const registry = registryFor('/repo/main');
    await registry.register(inputFor('api', 1));
    fs.writeFileSync(path.join(directory, 'runs', 'api.command.json'), '{ invalid json', 'utf8');
    fs.writeFileSync(path.join(directory, 'runs', 'api.exit.json'), '{ invalid json', 'utf8');
    const emitWarning = vi.spyOn(process, 'emitWarning');

    await expect(registry.listAll()).resolves.toMatchObject([{ id: 'api' }]);
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it('returns undefined for missing or malformed primary metadata', async () => {
    const registry = registryFor('/repo/main');
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    await expect(registry.get('missing')).resolves.toBeUndefined();
    expect(emitWarning).not.toHaveBeenCalled();

    fs.mkdirSync(path.join(directory, 'runs'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'runs', 'malformed.json'), '{ invalid json', 'utf8');
    await expect(registry.get('malformed')).resolves.toBeUndefined();

    const registered = await registry.register(inputFor('api', 1));
    fs.writeFileSync(
      path.join(directory, 'runs', 'mismatched.json'),
      JSON.stringify({ ...registered, id: 'different-id' }),
      'utf8',
    );
    await expect(registry.get('mismatched')).resolves.toBeUndefined();
    expect(emitWarning).toHaveBeenCalledTimes(2);
  });

  it('warns about malformed primary records while listing valid history', async () => {
    const registry = registryFor('/repo/main');
    await registry.register(inputFor('api', 1));
    fs.writeFileSync(path.join(directory, 'runs', 'broken.json'), '{ invalid json', 'utf8');
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    await expect(registry.listAll()).resolves.toMatchObject([{ id: 'api' }]);
    expect(emitWarning).toHaveBeenCalledOnce();
  });

  it('notifies subscribers when runners are registered and released', async () => {
    const registry = registryFor('/repo/main');
    let changes = 0;
    const unsubscribe = registry.subscribe(() => {
      changes += 1;
    });

    await registry.register(inputFor('api', 1));
    await registry.release('api');
    unsubscribe();
    await registry.register(inputFor('web', 2));

    expect(changes).toBe(2);
  });

  it('never returns a runner belonging to a sibling worktree', async () => {
    await registryFor('/repo/main').register(inputFor('api', 1));
    const sibling = registryFor('/repo/feature');
    await sibling.register(inputFor('api', 2));

    expect((await sibling.list()).map((record) => record.pid)).toEqual([2]);
    expect((await registryFor('/repo/main').list()).map((record) => record.pid)).toEqual([1]);
  });

  it('filters by the session that started the runner', async () => {
    const registry = registryFor('/repo/main');
    await registry.register(inputFor('api', 1, 'session-a'));
    await registry.register(inputFor('web', 2, 'session-b'));

    expect((await registry.listBySession('session-b')).map((record) => record.name)).toEqual(['web']);
  });

  it('lists descendant-owned runners by their inherited root without changing ownership', async () => {
    const registry = registryFor('/repo/main');
    process.env[SUBAGENT_ROOT_SESSION_ENV] = 'root-session';
    await registry.register(inputFor('child-api', 1, 'child-session'));
    delete process.env[SUBAGENT_ROOT_SESSION_ENV];
    await registry.register(inputFor('other-api', 2, 'other-root'));

    expect((await registry.listByRootSession('root-session')).map((record) => record.name)).toEqual(['child-api']);
    expect((await registry.listBySession('root-session')).map((record) => record.name)).toEqual([]);
    expect((await registry.listBySession('child-session')).map((record) => record.name)).toEqual(['child-api']);
  });

  it('releases an entry without touching the rest', async () => {
    const registry = registryFor('/repo/main');
    await registry.register(inputFor('api', 1));
    await registry.register(inputFor('web', 2));

    await registry.release('api');

    expect((await registry.list()).map((record) => record.name)).toEqual(['web']);
  });

  it('treats releasing an unknown runner as a no-op', async () => {
    await expect(registryFor('/repo/main').release('absent')).resolves.toBeUndefined();
  });

  it('surfaces a registration failure', async () => {
    const registry = registryFor('/repo/main', new Set(), failingPort('disk is full'));
    await expect(registry.register(inputFor('api', 1))).rejects.toThrow('disk is full');
  });

  it('reports a registration failure that carries no message', async () => {
    const registry = registryFor('/repo/main', new Set(), failingPort(undefined));
    await expect(registry.register(inputFor('api', 1))).rejects.toThrow('Failed to register runner api');
  });

  it('surfaces a release failure that is not a missing entry', async () => {
    const registry = registryFor('/repo/main', new Set(), failingPort('registry is locked'));
    await expect(registry.release('api')).rejects.toThrow('registry is locked');
  });

  it('prunes entries whose process is gone', async () => {
    const registry = registryFor('/repo/main', new Set([2]));
    await registry.register(inputFor('api', 1));
    await registry.register(inputFor('web', 2));

    expect(await registry.pruneDead()).toEqual(['api']);
    expect((await registry.list()).map((record) => record.name)).toEqual(['web']);
  });

  it('recovers active registry metadata for the requested owning session', async () => {
    const registry = registryFor('/repo/main');
    await registry.register(inputFor('api', 1));
    fs.rmSync(path.join(directory, 'runs', 'api.json'));

    const completed = await registry.complete('api', { reason: 'completed', code: 0, signal: null }, 'session-a');

    expect(completed?.sessionId).toBe('session-a');
    expect((await registry.get('api', 'session-a'))?.state).toBe('completed');
  });

  it('does not complete an active runner from another session', async () => {
    const registry = registryFor('/repo/main');
    await registry.register(inputFor('api', 1));
    fs.rmSync(path.join(directory, 'runs', 'api.json'));

    await expect(
      registry.complete('api', { reason: 'completed', code: 0, signal: null }, 'session-b'),
    ).resolves.toBeUndefined();
    expect((await registry.list()).map((record) => record.id)).toEqual(['api']);
  });

  it('keeps the first terminal outcome for an explicitly owned session', async () => {
    const registry = registryFor('/repo/main');
    await registry.register(inputFor('api', 1));
    await registry.complete('api', { reason: 'stopped', code: null, signal: 'SIGTERM' }, 'session-a');

    await registry.complete('api', { reason: 'signaled', code: null, signal: 'SIGTERM' }, 'session-a');

    expect((await registry.get('api', 'session-a'))?.exit?.reason).toBe('stopped');
  });

  describe('alarms', () => {
    it('arms an alarm from the start time only when an interval is given', async () => {
      const registry = registryFor('/repo/main');
      const armed = await registry.register({ ...inputFor('api', 1), alarmMs: 30_000 });
      await registry.register(inputFor('web', 2));

      expect(armed.alarm).toEqual({ intervalMs: 30_000, lastFiredAt: armed.startedAt });
      expect((await registry.get('web'))?.alarm).toBeUndefined();
    });

    it('disarms an alarm', async () => {
      const registry = registryFor('/repo/main');
      await registry.register({ ...inputFor('api', 1), alarmMs: 30_000 });

      expect((await registry.clearAlarm('api'))?.alarm).toBeUndefined();
      expect((await registry.get('api'))?.alarm).toBeUndefined();
    });

    it('leaves a runner without an alarm untouched, and reports an unknown runner', async () => {
      const registry = registryFor('/repo/main');
      await registry.register(inputFor('api', 1));

      expect((await registry.clearAlarm('api'))?.name).toBe('api');
      expect(await registry.clearAlarm('missing')).toBeUndefined();
    });

    it('reschedules a fire from the reported time', async () => {
      const registry = registryFor('/repo/main');
      await registry.register({ ...inputFor('api', 1), alarmMs: 30_000 });

      const fired = await registry.markAlarmFired('api', '2026-01-01T00:00:00.000Z');

      expect(fired?.alarm).toEqual({ intervalMs: 30_000, lastFiredAt: '2026-01-01T00:00:00.000Z' });
      expect((await registry.get('api'))?.alarm?.lastFiredAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('drops an in-flight fire once the alarm is disarmed', async () => {
      const registry = registryFor('/repo/main');
      await registry.register({ ...inputFor('api', 1), alarmMs: 30_000 });
      await registry.clearAlarm('api');

      expect(await registry.markAlarmFired('api', '2026-01-01T00:00:00.000Z')).toBeUndefined();
    });

    it('drops an in-flight fire once the runner has finished', async () => {
      const registry = registryFor('/repo/main');
      await registry.register({ ...inputFor('api', 1), alarmMs: 30_000 });
      await registry.complete('api', { reason: 'completed', code: 0, signal: null });

      expect(await registry.markAlarmFired('api', '2026-01-01T00:00:00.000Z')).toBeUndefined();
    });
  });
});
