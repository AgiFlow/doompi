import { describe, expect, it } from 'vitest';
import {
  FINISHED_RUNNER_RETENTION_MS,
  parseRunnerRecord,
  presentRunnerRuns,
  toRunnerRunView,
} from '../../src/services/webRunnerRuns.ts';
import type { RunnerRecord } from '../../src/types/runnerRegistry';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');

function record(overrides: Partial<RunnerRecord>): RunnerRecord {
  return {
    id: 'runner-a',
    name: 'api',
    pid: 42,
    command: 'pnpm dev',
    cwd: '/repo',
    logPath: '/tmp/api.log',
    interactive: false,
    sessionId: 's1',
    startedAt: '2026-08-24T11:00:00.000Z',
    state: 'running',
    promoted: true,
    backend: 'native',
    hostPid: 7,
    ...overrides,
  };
}

describe('web runner runs', () => {
  it('parses a record and rejects anything else', () => {
    expect(parseRunnerRecord(JSON.stringify(record({})))?.id).toBe('runner-a');
    expect(parseRunnerRecord('{"id":"x"}')).toBeUndefined();
    expect(parseRunnerRecord('not json')).toBeUndefined();
  });

  it('projects the view without host-only fields, keeping the log path and the exit', () => {
    const view = toRunnerRunView(
      record({
        state: 'completed',
        exit: {
          reason: 'stopped',
          code: null,
          signal: 'SIGTERM',
          stopReason: 'done',
          finishedAt: '2026-08-24T11:30:00.000Z',
        },
      }),
    );
    expect(view).toEqual({
      id: 'runner-a',
      name: 'api',
      pid: 42,
      command: 'pnpm dev',
      cwd: '/repo',
      interactive: false,
      backend: 'native',
      state: 'completed',
      promoted: true,
      startedAt: '2026-08-24T11:00:00.000Z',
      logPath: '/tmp/api.log',
      exit: {
        reason: 'stopped',
        code: null,
        signal: 'SIGTERM',
        stopReason: 'done',
        finishedAt: '2026-08-24T11:30:00.000Z',
      },
    });
    // The log path is carried: the cockpit only ever receives a bounded tail,
    // so naming the whole log is the only way a reader can reach it.
    expect(view.logPath).toBe('/tmp/api.log');
    expect('hostPid' in view).toBe(false);
    expect(toRunnerRunView(record({})).exit).toBeUndefined();
  });

  it('lists running first (newest start first), then recent exits, dropping stale ones', () => {
    const recent = new Date(NOW - FINISHED_RUNNER_RETENTION_MS / 2).toISOString();
    const stale = new Date(NOW - FINISHED_RUNNER_RETENTION_MS - 1).toISOString();
    const runs = presentRunnerRuns(
      [
        record({ id: 'old-run', startedAt: '2026-08-24T10:00:00.000Z' }),
        record({
          id: 'stale',
          state: 'completed',
          exit: { reason: 'completed', code: 0, signal: null, finishedAt: stale },
        }),
        record({
          id: 'fresh',
          state: 'completed',
          exit: { reason: 'failed', code: 1, signal: null, finishedAt: recent },
        }),
        record({ id: 'new-run', startedAt: '2026-08-24T11:30:00.000Z' }),
      ],
      NOW,
    );
    expect(runs.map((run) => run.id)).toEqual(['new-run', 'old-run', 'fresh']);
  });
});
