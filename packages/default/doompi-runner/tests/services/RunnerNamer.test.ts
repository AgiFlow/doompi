import { describe, expect, it } from 'vitest';
import { RunnerNamer } from '../../src/services/RunnerNamer/RunnerNamer';
import type { IRunnerRegistry, RunnerRecord } from '../../src/types/runnerRegistry';

function registryWith(names: string[], otherSessionNames: string[] = []): IRunnerRegistry {
  const records = [
    ...names.map((name) => ({ name, sessionId: 'session-a' }) as RunnerRecord),
    ...otherSessionNames.map((name) => ({ name, sessionId: 'session-b' }) as RunnerRecord),
  ];
  return {
    register: async () => records[0] as RunnerRecord,
    list: async () => records,
    listAcrossRepositories: async () => records,
    listBySession: async (sessionId) => records.filter((record) => record.sessionId === sessionId),
    listByRootSession: async (rootSessionId) =>
      records.filter((record) => (record.rootSessionId ?? record.sessionId) === rootSessionId),
    listAll: async () => records,
    get: async () => undefined,
    markPromoted: async () => undefined,
    clearAlarm: async () => undefined,
    markAlarmFired: async () => undefined,
    complete: async () => undefined,
    release: async () => undefined,
    pruneDead: async () => [],
    subscribe: () => () => undefined,
    close: () => undefined,
  };
}

describe('RunnerNamer', () => {
  it('derives a readable slug from the command', async () => {
    const namer = new RunnerNamer(registryWith([]));
    expect(await namer.allocate('nx dev-start receiptnote-api', 'session-a')).toBe('nx-dev-start-receiptnote-api');
  });

  it('skips flags, assignments and shell wrappers', async () => {
    const namer = new RunnerNamer(registryWith([]));
    expect(await namer.allocate('sudo NODE_ENV=production node --watch server.js', 'session-a')).toBe('node-server-js');
  });

  it('prefers the requested name when it is free', async () => {
    const namer = new RunnerNamer(registryWith(['api']));
    expect(await namer.allocate('anything', 'session-a', 'Web Server')).toBe('web-server');
  });

  it('numbers around a name a live runner already holds', async () => {
    const namer = new RunnerNamer(registryWith(['api', 'api-2']));
    expect(await namer.allocate('anything', 'session-a', 'api')).toBe('api-3');
  });

  it('falls back when the command yields no usable characters', async () => {
    const namer = new RunnerNamer(registryWith([]));
    expect(await namer.allocate('--- ===', 'session-a')).toBe('runner');
  });

  it('does not reserve names held only by another agent session', async () => {
    const namer = new RunnerNamer(registryWith([], ['api']));
    expect(await namer.allocate('anything', 'session-a', 'api')).toBe('api');
  });
});
