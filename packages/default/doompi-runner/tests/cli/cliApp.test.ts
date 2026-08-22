import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runCli, type CliDependencies } from '../../src/exports/cli/cliApp';
import type { IRunnerRegistry, RunnerRecord } from '../../src/types/runnerRegistry';

function record(overrides: Partial<RunnerRecord> = {}): RunnerRecord {
  return {
    id: 'mep4hd3a-X7qP',
    name: 'api',
    pid: 42,
    command: 'sleep 60',
    cwd: '/repo',
    logPath: '/logs/runner.log',
    interactive: false,
    sessionId: 'session-a',
    startedAt: '2026-08-03T00:00:00.000Z',
    state: 'running',
    promoted: true,
    backend: 'native',
    hostPid: 1,
    ...overrides,
  };
}

function harness(
  records: RunnerRecord[] = [record()],
  env: NodeJS.ProcessEnv = { PI_SESSION_ID: 'session-a' },
): {
  dependencies: CliDependencies;
  output: string[];
  errors: string[];
  stopped: number[];
  rmuxStopped: string[];
  rmuxInput: Array<{ target: string; text: string }>;
  completed: string[];
} {
  const output: string[] = [];
  const errors: string[] = [];
  const stopped: number[] = [];
  const rmuxStopped: string[] = [];
  const rmuxInput: Array<{ target: string; text: string }> = [];
  const completed: string[] = [];
  const registry: IRunnerRegistry = {
    register: async () => records[0] as RunnerRecord,
    list: async () => records.filter((entry) => entry.state === 'running'),
    listAcrossRepositories: async () => records.filter((entry) => entry.state === 'running'),
    listBySession: async (sessionId) =>
      records.filter((entry) => entry.state === 'running' && entry.sessionId === sessionId),
    listByRootSession: async (rootSessionId) =>
      records.filter((entry) => (entry.rootSessionId ?? entry.sessionId) === rootSessionId),
    listAll: async (sessionId) => records.filter((entry) => !sessionId || entry.sessionId === sessionId),
    get: async (id, sessionId) =>
      records.find((entry) => entry.id === id && (!sessionId || entry.sessionId === sessionId)),
    markPromoted: async () => undefined,
    clearAlarm: async () => undefined,
    markAlarmFired: async () => undefined,
    complete: async (id) => {
      completed.push(id);
      return records.find((entry) => entry.id === id);
    },
    release: async () => undefined,
    pruneDead: async () => [],
    subscribe: () => () => undefined,
    close: () => undefined,
  };
  return {
    dependencies: {
      registry,
      launcher: {
        launch: vi.fn(),
        stop: async (pid) => {
          stopped.push(pid);
          return true;
        },
      },
      rmuxBackend: {
        launch: async () => undefined,
        watch: async () => undefined,
        readOutcome: () => undefined,
        stop: async (target) => {
          rmuxStopped.push(target);
          return true;
        },
        input: async (target, text) => {
          rmuxInput.push({ target, text });
          return true;
        },
        get: () => undefined,
      },
      logReader: {
        read: () => ({
          text: 'hello\n',
          exists: true,
          fileSize: 6,
          totalLines: 1,
          returnedLines: 1,
          lineCount: 1,
          path: '/logs/runner.log',
        }),
      },
      env,
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
      readStdin: async () => '',
    },
    output,
    errors,
    stopped,
    rmuxStopped,
    rmuxInput,
    completed,
  };
}

describe('doom-runner CLI', () => {
  it('lists active runners and can include completed runners', async () => {
    const completed = record({ id: 'mep4hd3b-K2mN', state: 'completed' });
    const run = harness([record(), completed]);

    await expect(runCli(['list'], run.dependencies)).resolves.toBe(0);
    await expect(runCli(['list', '--all'], run.dependencies)).resolves.toBe(0);

    expect(run.output[0]).not.toContain(completed.id);
    expect(run.output[1]).toContain(completed.id);
  });

  it('scopes list and direct runner access to the inherited agent session', async () => {
    const owned = record();
    const other = record({ id: 'mep4hd3b-K2mN', sessionId: 'session-b' });
    const run = harness([owned, other], { PI_SESSION_ID: 'session-a' });

    await expect(runCli(['list'], run.dependencies)).resolves.toBe(0);
    await expect(runCli(['list', '--all'], run.dependencies)).resolves.toBe(0);
    await expect(runCli(['status', other.id], run.dependencies)).resolves.toBe(1);

    expect(run.output[0]).toContain(owned.id);
    expect(run.output[0]).not.toContain(other.id);
    expect(run.output[1]).toContain(owned.id);
    expect(run.output[1]).not.toContain(other.id);
    expect(run.errors).toEqual([`No runner with id ${other.id}`]);
  });

  it('reports when there are no runners', async () => {
    const run = harness([]);
    await expect(runCli(['list'], run.dependencies)).resolves.toBe(0);
    expect(run.output).toEqual(['No runners']);
  });

  it('shows RMUX backend and exit details in status', async () => {
    const run = harness([
      record({
        backend: 'rmux',
        backendTarget: 'doom-runner-id',
        state: 'completed',
        exit: {
          reason: 'stopped',
          code: null,
          signal: 'SIGTERM',
          stopReason: 'session ended',
          finishedAt: '2026-08-03T00:01:00.000Z',
        },
      }),
    ]);

    await expect(runCli(['status', record().id], run.dependencies)).resolves.toBe(0);

    expect(run.output[0]).toContain('Backend target: doom-runner-id');
    expect(run.output[0]).toContain('stopped SIGTERM (session ended)');
  });

  it('shows a numeric exit code without an optional note', async () => {
    const completed = record({
      state: 'completed',
      exit: { reason: 'failed', code: 2, signal: null, finishedAt: '2026-08-03T00:01:00.000Z' },
    });
    const run = harness([completed]);

    await expect(runCli(['status', completed.id], run.dependencies)).resolves.toBe(0);
    expect(run.output[0]).toContain('Exit: failed code 2');
  });

  it('reads a runner log by ID', async () => {
    const run = harness();

    await expect(runCli(['logs', record().id], run.dependencies)).resolves.toBe(0);

    expect(run.output).toEqual(['hello\n']);
  });

  it('requires a known runner ID', async () => {
    const run = harness();

    await expect(runCli(['status'], run.dependencies)).resolves.toBe(1);
    await expect(runCli(['status', 'missing'], run.dependencies)).resolves.toBe(1);

    expect(run.errors).toEqual(['A runner ID is required', 'No runner with id missing']);
  });

  it('reports a missing log', async () => {
    const run = harness();
    run.dependencies.logReader.read = () => ({
      text: '',
      exists: false,
      fileSize: 0,
      totalLines: 0,
      returnedLines: 0,
      lineCount: 0,
      path: '/logs/runner.log',
    });

    await expect(runCli(['logs', record().id], run.dependencies)).resolves.toBe(1);
    expect(run.errors[0]).toContain('has not written a log yet');
  });

  it('accepts an existing empty log', async () => {
    const run = harness();
    run.dependencies.logReader.read = () => ({
      text: '',
      exists: true,
      fileSize: 0,
      totalLines: 0,
      returnedLines: 0,
      lineCount: 0,
      path: '/logs/runner.log',
    });

    await expect(runCli(['logs', record().id], run.dependencies)).resolves.toBe(0);
    expect(run.output).toEqual([]);
  });

  it('follows appended output until the runner completes', async () => {
    vi.useFakeTimers();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-runner-follow-'));
    const logPath = path.join(directory, 'runner.log');
    fs.writeFileSync(logPath, 'hello\n');
    const completed = record({ logPath, state: 'completed' });
    const run = harness([completed]);
    run.dependencies.logReader.read = () => ({
      text: 'hello\n',
      exists: true,
      fileSize: 100,
      totalLines: 1,
      returnedLines: 1,
      lineCount: 1,
      path: logPath,
    });
    fs.appendFileSync(logPath, 'done\n');

    const following = runCli(['logs', completed.id, '--lines', 'invalid', '--follow'], run.dependencies);
    await vi.advanceTimersByTimeAsync(300);
    await expect(following).resolves.toBe(0);

    vi.useRealTimers();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('fails closed when stop-all has no inherited session id', async () => {
    const run = harness([record()], {});

    await expect(runCli(['stop-all'], run.dependencies)).resolves.toBe(1);

    expect(run.stopped).toEqual([]);
    expect(run.errors[0]).toContain('PI_SESSION_ID is required');
  });

  it('fails closed for direct commands without an inherited session id', async () => {
    const run = harness([record()], {});

    await expect(runCli(['list'], run.dependencies)).resolves.toBe(1);
    await expect(runCli(['status', record().id], run.dependencies)).resolves.toBe(1);

    expect(run.errors).toEqual([
      'PI_SESSION_ID is required for doom-runner commands',
      'PI_SESSION_ID is required for doom-runner commands',
    ]);
  });

  it('stops only runners owned by the inherited session', async () => {
    const owned = record();
    const other = record({ id: 'mep4hd3b-K2mN', pid: 84, sessionId: 'session-b' });
    const run = harness([owned, other], { PI_SESSION_ID: 'session-a' });

    await expect(runCli(['stop-all', '--reason', 'done'], run.dependencies)).resolves.toBe(0);

    expect(run.stopped).toEqual([42]);
    expect(run.completed).toEqual([owned.id]);
    expect(run.output[0]).toContain(owned.id);
    expect(run.output[0]).not.toContain(other.id);
  });

  it('reports when the inherited session has no active runner', async () => {
    const run = harness([], { PI_SESSION_ID: 'session-a' });
    await expect(runCli(['stop-all'], run.dependencies)).resolves.toBe(0);
    expect(run.output).toEqual(['No active runners for session session-a']);
  });

  it('stops an RMUX runner through its backend target', async () => {
    const rmux = record({ backend: 'rmux', backendTarget: 'doom-runner-id' });
    const run = harness([rmux]);

    await expect(runCli(['stop', rmux.id, '--reason', 'done'], run.dependencies)).resolves.toBe(0);

    expect(run.rmuxStopped).toEqual(['doom-runner-id']);
    expect(run.completed).toEqual([rmux.id]);
  });

  it('does not stop an already completed runner', async () => {
    const completed = record({ state: 'completed' });
    const run = harness([completed]);

    await expect(runCli(['stop', completed.id], run.dependencies)).resolves.toBe(1);
    expect(run.errors[0]).toContain('already completed');
  });

  it('sends input and an optional enter key to an interactive RMUX runner', async () => {
    const rmux = record({ interactive: true, backend: 'rmux', backendTarget: 'doom-runner-id' });
    const run = harness([rmux]);

    await expect(runCli(['input', rmux.id, '--text', 'yes', '--enter'], run.dependencies)).resolves.toBe(0);

    expect(run.rmuxInput).toEqual([{ target: 'doom-runner-id', text: 'yes\n' }]);
  });

  it('reads RMUX input from stdin without duplicating a newline', async () => {
    const rmux = record({ interactive: true, backend: 'rmux', backendTarget: 'doom-runner-id' });
    const run = harness([rmux]);
    run.dependencies.readStdin = async () => 'answer\n';

    await expect(runCli(['input', rmux.id, '--enter'], run.dependencies)).resolves.toBe(0);
    expect(run.rmuxInput[0]?.text).toBe('answer\n');
  });

  it('rejects input for non-interactive and native runners', async () => {
    const nonInteractive = harness();
    await expect(runCli(['input', record().id, '--text', 'x'], nonInteractive.dependencies)).resolves.toBe(1);

    const native = record({ interactive: true });
    const nativeRun = harness([native]);
    await expect(runCli(['input', native.id, '--text', 'x'], nativeRun.dependencies)).resolves.toBe(1);

    expect(nonInteractive.errors[0]).toContain('interactive: true');
    expect(nativeRun.errors[0]).toContain('does not expose CLI input');
  });

  it('rejects an RMUX runner without a backend target', async () => {
    const rmux = record({ interactive: true, backend: 'rmux' });
    const run = harness([rmux]);

    await expect(runCli(['input', rmux.id, '--text', 'x'], run.dependencies)).resolves.toBe(1);
    expect(run.errors[0]).toContain('does not expose CLI input');
  });

  it('reports an RMUX pane that no longer accepts input', async () => {
    const rmux = record({ interactive: true, backend: 'rmux', backendTarget: 'doom-runner-id' });
    const run = harness([rmux]);
    run.dependencies.rmuxBackend.input = async () => false;

    await expect(runCli(['input', rmux.id, '--text', 'x'], run.dependencies)).resolves.toBe(1);
    expect(run.errors[0]).toContain('no longer accepting');
  });

  it('does not call RMUX input for a completed runner', async () => {
    const completed = record({
      interactive: true,
      backend: 'rmux',
      backendTarget: 'doom-runner-id',
      state: 'completed',
    });
    const run = harness([completed]);

    await expect(runCli(['input', completed.id, '--text', 'x'], run.dependencies)).resolves.toBe(1);

    expect(run.rmuxInput).toEqual([]);
    expect(run.errors[0]).toContain('already completed');
  });

  it('prints help and rejects unknown commands', async () => {
    const run = harness();

    await expect(runCli([], run.dependencies)).resolves.toBe(0);
    await expect(runCli(['unknown'], run.dependencies)).resolves.toBe(1);

    expect(run.output[0]).toContain('Usage: doom-runner');
    expect(run.errors[0]).toContain('Unknown command: unknown');
  });
});
