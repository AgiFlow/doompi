import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BashRunService } from '../../src/adapters/BashRunService/BashRunService';
import { Launcher } from '../../src/adapters/Launcher/Launcher';
import { RmuxBackend } from '../../src/adapters/RmuxBackend/RmuxBackend';
import type { RunHandle } from '../../src/types/launcher';
import type { IRunnerNamer } from '../../src/services/RunnerNamer/types';
import type { IRmuxBackend } from '../../src/types/rmuxBackend';
import type { IRtkProcessor } from '../../src/types/rtkProcessor';

import type { IRunnerPaths } from '../../src/services/RunnerPaths/types';
import type { IRunnerRegistry, RegisterRunnerInput, RunnerRecord } from '../../src/types/runnerRegistry';
import type { ExitResult } from '../../src/types/spawner';
import {
  FakeClock,
  FakeLogFile,
  FakeProcessControl,
  FakeRtkProcessor,
  FakeRunnerPaths,
  FakeSpawner,
} from '../doubles.ts';

const rmuxMocks = vi.hoisted(() => ({
  capabilities: vi.fn(async () => ({})),
  cmd: vi.fn(async () => ({})),
  displayMessage: vi.fn(),
  sessionKill: vi.fn(async () => undefined),
  captureText: vi.fn(async () => ''),
  sendText: vi.fn(async () => ({})),
  resize: vi.fn(async () => ({})),
}));

vi.mock('@rmux/sdk', () => ({
  RMUX: class {
    capabilities = rmuxMocks.capabilities;
    cmd = rmuxMocks.cmd;
    displayMessage = rmuxMocks.displayMessage;

    session() {
      const pane = {
        server: { session: () => ({ kill: rmuxMocks.sessionKill }) },
        captureText: rmuxMocks.captureText,
        sendText: rmuxMocks.sendText,
        resize: rmuxMocks.resize,
      };
      return { kill: rmuxMocks.sessionKill, pane: () => pane };
    }
  },
}));

const THRESHOLD_MS = 60_000;
const OUTPUT_UPDATE_POLL_MS = 100;

/** Records what was registered without touching the real registry. */
class RecordingRegistry implements IRunnerRegistry {
  readonly registered: RegisterRunnerInput[] = [];
  readonly released: string[] = [];

  async register(input: RegisterRunnerInput): Promise<RunnerRecord> {
    this.registered.push(input);
    return { ...input, startedAt: 'now', state: 'running', promoted: false, hostPid: 1 };
  }

  async list(): Promise<RunnerRecord[]> {
    return [];
  }

  async listAcrossRepositories(): Promise<RunnerRecord[]> {
    return [];
  }

  async listBySession(): Promise<RunnerRecord[]> {
    return [];
  }

  async listByRootSession(): Promise<RunnerRecord[]> {
    return [];
  }

  async listAll(): Promise<RunnerRecord[]> {
    return [];
  }

  async get(): Promise<RunnerRecord | undefined> {
    return undefined;
  }

  async markPromoted(): Promise<RunnerRecord | undefined> {
    return undefined;
  }

  async clearAlarm(): Promise<RunnerRecord | undefined> {
    return undefined;
  }

  async markAlarmFired(): Promise<RunnerRecord | undefined> {
    return undefined;
  }

  async complete(): Promise<RunnerRecord | undefined> {
    return undefined;
  }

  async release(name: string): Promise<void> {
    this.released.push(name);
  }

  async pruneDead(): Promise<string[]> {
    return [];
  }

  subscribe(): () => void {
    return () => undefined;
  }

  close(): void {}
}

const namer: IRunnerNamer = {
  allocate: async (_command, _sessionId, requested) => requested ?? 'derived-name',
};
const rmuxBackend: IRmuxBackend = {
  launch: async () => undefined,
  watch: async () => undefined,
  readOutcome: () => undefined,
  stop: async () => false,
  input: async () => false,
  get: () => undefined,
};

/** `null` spawns a process that never reported a pid. */
function harness(
  pid: number | null = 4242,
  backend: IRmuxBackend = rmuxBackend,
  rtkProcessor: IRtkProcessor = new FakeRtkProcessor(),
) {
  const spawner = new FakeSpawner(pid ?? undefined);
  const clock = new FakeClock();
  const registry = new RecordingRegistry();
  const control = new FakeProcessControl(new Set([4242]));
  const launcherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-runner-native-'));
  const logFile = new FakeLogFile();
  const launcher = new Launcher(spawner, control, logFile, clock, new FakeRunnerPaths(launcherRoot));
  return {
    service: new BashRunService(launcher, backend, namer, registry, clock, rtkProcessor),
    spawner,
    clock,
    registry,
    control,
    rtkProcessor,
    logFile,
  };
}

const request = { command: 'echo hi', cwd: '/repo', sessionId: 'session-a' };

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('BashRunService', () => {
  it('uses a compact timestamped URL-safe runner ID', async () => {
    const { service } = harness();

    const result = await service.run({ ...request, background: true });

    expect(result.id).toMatch(/^[a-z0-9]+-[A-Za-z0-9_-]{4}$/);
  });

  it('returns the output when the command finishes inside the window', async () => {
    const { service, spawner } = harness();
    const running = service.run(request);

    await flushPromises();
    spawner.last.emit('hi\n');
    spawner.last.exit({ code: 0, signal: null });

    await expect(running).resolves.toMatchObject({
      kind: 'completed',
      name: 'derived-name',
      output: 'hi\n',
      exitCode: 0,
      signal: null,
      backend: 'native',
    });
  });

  it('reports a log write failure without crashing the host process', async () => {
    const { service, spawner, logFile } = harness();
    logFile.failAppendWith = new Error('disk full');
    const running = service.run(request);

    await flushPromises();
    expect(() => spawner.last.emit('unwritten output\n')).not.toThrow();
    await expect(running).resolves.toMatchObject({ kind: 'failed', error: 'disk full' });
  });
  it('attaches RTK output only after preserving the completed raw result', async () => {
    const process = vi.fn(async () => ({
      kind: 'processed' as const,
      result: { filter: 'cargo-test' as const, head: '', output: '2 passed\n', bytes: 9, lines: 1 },
    }));
    const { service, spawner } = harness(4242, rmuxBackend, { process });
    const running = service.run({ ...request, command: 'cargo test' });

    await flushPromises();
    spawner.last.emit('verbose raw output\n');
    spawner.last.exit({ code: 0, signal: null });

    await expect(running).resolves.toMatchObject({
      kind: 'completed',
      output: 'verbose raw output\n',
      rtkOutput: { filter: 'cargo-test', output: '2 passed\n' },
    });
    expect(process).toHaveBeenCalledWith({
      command: 'cargo test',
      logPath: expect.stringMatching(/^\/logs\/.+\.log$/u),
    });
  });

  it('preserves a successful command result when RTK falls back', async () => {
    const process = vi.fn(async () => ({
      kind: 'fallback' as const,
      warning: 'Warning: RTK is unavailable; showing raw output.',
    }));
    const { service, spawner } = harness(4242, rmuxBackend, { process });
    const running = service.run({ ...request, command: 'cargo test' });

    await flushPromises();
    spawner.last.emit('raw output\n');
    spawner.last.exit({ code: 0, signal: null });

    await expect(running).resolves.toMatchObject({
      kind: 'completed',
      output: 'raw output\n',
      exitCode: 0,
      rtkWarning: 'Warning: RTK is unavailable; showing raw output.',
    });
  });
  it('keeps the command result when the RTK processor throws', async () => {
    const rtkProcessor = new FakeRtkProcessor();
    rtkProcessor.failWith = new Error('spawn EACCES');
    const { service, spawner } = harness(4242, rmuxBackend, rtkProcessor);
    const running = service.run({ ...request, command: 'cargo test' });

    await flushPromises();
    spawner.last.emit('raw output\n');
    spawner.last.exit({ code: 0, signal: null });

    await expect(running).resolves.toMatchObject({
      kind: 'completed',
      output: 'raw output\n',
      exitCode: 0,
      rtkWarning: 'Warning: RTK processing failed; showing raw output.',
    });
  });

  it('streams changed foreground output and stops polling after completion', async () => {
    const { service, spawner, clock } = harness();
    const updates: string[] = [];
    const running = service.run({ ...request, onOutput: (output) => updates.push(output) });

    await flushPromises();
    spawner.last.emit('one\n');
    await clock.advance(OUTPUT_UPDATE_POLL_MS);
    expect(updates).toEqual(['one\n']);

    await clock.advance(OUTPUT_UPDATE_POLL_MS);
    expect(updates).toEqual(['one\n']);

    spawner.last.emit('two\n');
    await clock.advance(OUTPUT_UPDATE_POLL_MS);
    expect(updates).toEqual(['one\n', 'one\ntwo\n']);

    spawner.last.exit();
    await running;
    expect(clock.pending).toBe(0);
  });

  it('flushes output when a command completes before the first poll', async () => {
    const { service, spawner, clock } = harness();
    const updates: string[] = [];
    const running = service.run({ ...request, onOutput: (output) => updates.push(output) });

    await flushPromises();
    spawner.last.emit('quick\n');
    spawner.last.exit();

    await running;
    expect(updates).toEqual(['quick\n']);
    expect(clock.pending).toBe(0);
  });

  it('streams output from an RMUX-backed foreground handle', async () => {
    let output = '';
    let finish: (result: ExitResult) => void = () => undefined;
    const completion = new Promise<ExitResult>((resolve) => {
      finish = resolve;
    });
    const handle: RunHandle = {
      id: 'rmux-id',
      name: 'derived-name',
      pid: 4242,
      logPath: '/logs/rmux.log',
      backend: 'rmux',
      backendTarget: 'doom-runner-rmux-id',
      output: () => output,
      completion: () => completion,
      detach: () => undefined,
      stop: async () => true,
    };
    const backend: IRmuxBackend = { ...rmuxBackend, launch: async () => handle };
    const { service, clock } = harness(4242, backend);
    const updates: string[] = [];
    const running = service.run({ ...request, onOutput: (snapshot) => updates.push(snapshot) });

    await flushPromises();
    output = 'rmux output\n';
    await clock.advance(OUTPUT_UPDATE_POLL_MS);
    expect(updates).toEqual(['rmux output\n']);

    finish({ code: 0, signal: null });
    await running;
    expect(clock.pending).toBe(0);
  });

  it('reports a non-zero exit rather than treating it as a failure', async () => {
    const { service, spawner } = harness();
    const running = service.run(request);

    await flushPromises();
    spawner.last.exit({ code: 2, signal: null });

    await expect(running).resolves.toMatchObject({ kind: 'completed', exitCode: 2 });
  });

  it('promotes a command that outlives the threshold after flushing its output', async () => {
    const { service, spawner, clock, registry } = harness();
    const updates: string[] = [];
    const running = service.run({ ...request, onOutput: (output) => updates.push(output) });

    await flushPromises();
    spawner.last.emit('starting\n');
    await clock.advance(THRESHOLD_MS);

    await expect(running).resolves.toMatchObject({
      kind: 'promoted',
      name: 'derived-name',
      pid: 4242,
      backend: 'native',
      reason: 'threshold',
    });
    expect(updates).toContain('starting\n');
    expect(clock.pending).toBe(0);
    expect(registry.registered).toEqual([
      expect.objectContaining({
        name: 'derived-name',
        pid: 4242,
        command: 'echo hi',
        cwd: '/repo',
        interactive: false,
        sessionId: 'session-a',
        backend: 'native',
      }),
    ]);
  });

  it.each([
    ['background', { background: true }],
    ['interactive', { interactive: true }],
  ])('does not stream %s runs', async (_mode, options) => {
    const { service, clock } = harness();
    const updates: string[] = [];

    await service.run({ ...request, ...options, onOutput: (output) => updates.push(output) });

    expect(updates).toEqual([]);
    expect(clock.pending).toBe(0);
  });

  it('backgrounds immediately when asked, without waiting', async () => {
    const { service, clock, registry } = harness();

    await expect(service.run({ ...request, background: true })).resolves.toMatchObject({
      kind: 'promoted',
      reason: 'requested',
      backend: 'native',
    });
    expect(registry.registered).toHaveLength(1);
    expect(clock.pending).toBe(0);
  });

  it('releases a promoted runner when its process exits', async () => {
    const { service, spawner, registry } = harness();
    await service.run({ ...request, background: true });

    spawner.last.exit();
    await Promise.resolve();
    await Promise.resolve();

    expect(registry.released).toEqual([]);
  });

  it('honours a requested runner name', async () => {
    const { service } = harness();
    const result = await service.run({ ...request, background: true, name: 'web' });
    expect(result).toMatchObject({ name: 'web', backend: 'native' });
  });

  it('cancels the threshold timer once the command finishes', async () => {
    const { service, spawner, clock } = harness();
    const running = service.run(request);

    await flushPromises();
    spawner.last.exit();
    await running;

    expect(clock.pending).toBe(0);
  });

  it('reports a command that never started as a failure', async () => {
    const { service, spawner } = harness();
    const running = service.run(request);

    await flushPromises();
    spawner.last.fail(new Error('spawn ENOENT'));

    await expect(running).resolves.toMatchObject({ kind: 'failed', name: 'derived-name', error: 'spawn ENOENT' });
  });

  it('refuses to background a command that never got a pid', async () => {
    const { service, registry } = harness(null);

    await expect(service.run({ ...request, background: true })).resolves.toMatchObject({ kind: 'failed' });
    expect(registry.registered).toEqual([]);
  });

  it('stops the command at an explicit timeout instead of promoting it', async () => {
    const { service, clock, registry, control } = harness();
    const running = service.run({ ...request, timeoutMs: 5_000 });

    await flushPromises();
    await clock.advance(5_000);
    // The stop path polls for liveness, so the process has to actually die.
    control.die(4242);
    await clock.advance(OUTPUT_UPDATE_POLL_MS);

    await expect(running).resolves.toMatchObject({
      kind: 'completed',
      timedOut: true,
      exitCode: null,
      signal: 'SIGTERM',
    });
    expect(registry.registered).toHaveLength(1);
  });

  it('still promotes when the timeout sits beyond the threshold', async () => {
    const { service, clock, registry } = harness();
    const running = service.run({ ...request, timeoutMs: 120_000 });

    await flushPromises();
    await clock.advance(THRESHOLD_MS);

    await expect(running).resolves.toMatchObject({ kind: 'promoted', reason: 'threshold' });
    expect(registry.registered).toHaveLength(1);
  });

  it('ignores a timeout of zero', async () => {
    const { service, spawner } = harness();
    const running = service.run({ ...request, timeoutMs: 0 });

    await flushPromises();
    spawner.last.exit();

    await expect(running).resolves.toMatchObject({ kind: 'completed', exitCode: 0 });
  });

  it('defaults the working directory to the current one', async () => {
    const { service, spawner } = harness();
    const running = service.run({ command: 'echo hi', sessionId: 'session-a' });

    await flushPromises();
    spawner.last.exit();
    await running;

    expect(spawner.last.request.cwd).toBe(process.cwd());
  });
});

describe('BashRunService interactive runs', () => {
  function availableRmux(): IRmuxBackend {
    const handle: RunHandle = {
      id: 'rmux-id',
      name: 'derived-name',
      pid: 4242,
      logPath: '/logs/rmux.log',
      backend: 'rmux',
      backendTarget: 'doom-runner-rmux-id',
      output: () => '',
      completion: () => new Promise<ExitResult>(() => undefined),
      detach: () => undefined,
      stop: async () => true,
    };
    return { ...rmuxBackend, launch: async () => handle };
  }

  it('hosts the command in RMUX and backgrounds it straight away', async () => {
    const { service, registry } = harness(4242, availableRmux());

    const result = await service.run({ ...request, interactive: true });

    expect(result).toMatchObject({ kind: 'promoted', reason: 'interactive', name: 'derived-name', backend: 'rmux' });
    expect(registry.registered[0]).toMatchObject({ interactive: true, backend: 'rmux' });
  });

  it('prefers an explicit background request over the interactive reason', async () => {
    const { service } = harness(4242, availableRmux());
    const result = await service.run({ ...request, interactive: true, background: true });
    expect(result).toMatchObject({ reason: 'requested' });
  });

  it('fails instead of falling back when RMUX is unavailable', async () => {
    const { service, registry } = harness();

    await expect(service.run({ ...request, interactive: true })).resolves.toMatchObject({
      kind: 'failed',
      name: 'derived-name',
      error: 'RMUX is required for interactive commands but is unavailable',
    });
    expect(registry.registered).toEqual([]);
  });
});

const RMUX_TARGET = 'doom-runner-run-a';
const RMUX_PID = 4242;
let rmuxRoot = '';
const rmuxPaths: IRunnerPaths = {
  repositoryPath: () => '/repo',
  setSessionId: () => undefined,
  logDirectory: () => path.join(rmuxRoot, 'logs'),
  stateDirectory: () => path.join(rmuxRoot, 'state'),
  logPathFor: (id) => path.join(rmuxRoot, 'logs', `${id}.log`),
  rotatedLogPathFor: (id) => path.join(rmuxRoot, 'logs', `${id}.1.log`),
  statePathFor: (id) => path.join(rmuxRoot, 'state', `${id}.json`),
  ensureDirectories: () => {
    fs.mkdirSync(path.join(rmuxRoot, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(rmuxRoot, 'state'), { recursive: true });
  },
  sweepHistory: () => ({ removed: [], errors: [] }),
  legacyDirectory: () => undefined,
  removeLegacyStore: () => undefined,
};

let rmuxPanePid = RMUX_PID;
let rmuxPaneDead = false;
let rmuxPaneExists = true;
let processKill: ReturnType<typeof vi.spyOn>;
let emitWarning: ReturnType<typeof vi.spyOn>;

describe('RmuxBackend.stop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rmuxMocks.capabilities.mockReset().mockResolvedValue({});
    // A session that ends with its pane is now the signal the backend reads, so
    // has-session has to answer honestly rather than succeed at everything.
    rmuxMocks.cmd.mockReset().mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'has-session') return { returnCode: rmuxPaneExists ? 0 : 1 };
      return {};
    });
    rmuxMocks.sessionKill.mockReset().mockResolvedValue(undefined);
    rmuxMocks.captureText.mockReset().mockResolvedValue('');
    rmuxMocks.sendText.mockReset().mockResolvedValue({});
    rmuxMocks.resize.mockReset().mockResolvedValue({});
    vi.useFakeTimers();
    rmuxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-runner-rmux-test-'));
    rmuxPanePid = RMUX_PID;
    rmuxPaneDead = false;
    rmuxPaneExists = true;
    rmuxMocks.displayMessage.mockImplementation(async (format: string) => {
      if (!rmuxPaneExists) throw new Error('target not found');
      if (format === '#{pane_pid}') return { message: String(rmuxPanePid) };
      if (format === '#{pane_dead}:#{pane_dead_status}:#{session_name}') {
        return { message: rmuxPaneDead ? '1:143:doom-runner-run-a' : '0::doom-runner-run-a' };
      }
      return { message: '' };
    });
    rmuxMocks.sessionKill.mockImplementation(async () => {
      rmuxPaneExists = false;
    });
    processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
  });

  afterEach(() => {
    processKill.mockRestore();
    emitWarning.mockRestore();
    fs.rmSync(rmuxRoot, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('refuses targets outside the Doom Runner namespace', async () => {
    const backend = new RmuxBackend(rmuxPaths);

    await expect(backend.stop('foreign-session', RMUX_PID)).resolves.toBe(false);

    expect(rmuxMocks.capabilities).not.toHaveBeenCalled();
    expect(processKill).not.toHaveBeenCalled();
  });

  it('refuses a pane whose pid no longer matches the tracked runner', async () => {
    rmuxPanePid = 9999;
    const backend = new RmuxBackend(rmuxPaths);

    await expect(backend.stop(RMUX_TARGET, RMUX_PID)).resolves.toBe(false);

    expect(processKill).not.toHaveBeenCalled();
    expect(rmuxMocks.sessionKill).not.toHaveBeenCalled();
  });

  it('returns after SIGTERM when the tracked pane exits inside the grace period', async () => {
    processKill.mockImplementation(() => {
      rmuxPaneDead = true;
      return true;
    });
    const backend = new RmuxBackend(rmuxPaths);

    await expect(backend.stop(RMUX_TARGET, RMUX_PID)).resolves.toBe(true);

    expect(processKill).toHaveBeenCalledWith(RMUX_PID, 'SIGTERM');
    expect(rmuxMocks.sessionKill).not.toHaveBeenCalled();
  });

  it('closes only the revalidated tracked session after the grace period', async () => {
    const backend = new RmuxBackend(rmuxPaths);
    const stopping = backend.stop(RMUX_TARGET, RMUX_PID);

    await vi.advanceTimersByTimeAsync(3_100);

    await expect(stopping).resolves.toBe(true);
    expect(processKill).toHaveBeenCalledWith(RMUX_PID, 'SIGTERM');
    expect(rmuxMocks.sessionKill).toHaveBeenCalledOnce();
  });

  it('refuses escalation when the pane is replaced during the grace period', async () => {
    let deadProbes = 0;
    rmuxMocks.displayMessage.mockImplementation(async (format: string) => {
      if (format === '#{pane_pid}') return { message: String(rmuxPanePid) };
      if (format === '#{pane_dead}:#{pane_dead_status}:#{session_name}') {
        deadProbes += 1;
        if (deadProbes >= 30) rmuxPanePid = 9999;
        return { message: `0::${RMUX_TARGET}` };
      }
      return { message: '' };
    });
    const backend = new RmuxBackend(rmuxPaths);
    const stopping = backend.stop(RMUX_TARGET, RMUX_PID);

    await vi.advanceTimersByTimeAsync(3_100);

    await expect(stopping).resolves.toBe(false);
    expect(rmuxMocks.sessionKill).not.toHaveBeenCalled();
  });

  it('reports an exact-session cleanup failure', async () => {
    rmuxMocks.sessionKill.mockRejectedValueOnce(new Error('rmux close failed'));
    const backend = new RmuxBackend(rmuxPaths);
    const stopping = backend.stop(RMUX_TARGET, RMUX_PID);

    await vi.advanceTimersByTimeAsync(3_100);

    await expect(stopping).resolves.toBe(false);
    expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('rmux close failed'));
  });

  it('launches a tracked pane and resolves its monitored exit', async () => {
    rmuxPaneDead = true;
    const backend = new RmuxBackend(rmuxPaths);

    const handle = await backend.launch({
      id: 'run-a',
      name: 'run-a',
      command: 'echo done',
      cwd: '/repo',
      sessionId: 'session-a',
      interactive: false,
    });

    expect(handle).toMatchObject({ pid: RMUX_PID, backend: 'rmux', backendTarget: RMUX_TARGET });
    // new-session and pipe-pane. The pane is no longer told to remain on exit,
    // so it ends its own session instead of leaving one behind.
    expect(rmuxMocks.cmd).toHaveBeenCalledTimes(2);
    expect(rmuxMocks.cmd).not.toHaveBeenCalledWith(
      expect.stringContaining('set-window-option'),
      expect.anything(),
      expect.anything(),
      'remain-on-exit',
      expect.anything(),
      expect.anything(),
    );
    await vi.advanceTimersByTimeAsync(2_100);
    await expect(handle?.completion()).resolves.toEqual({ code: 143, signal: null });
    expect(rmuxMocks.sessionKill).toHaveBeenCalled();
  });

  it('sends input only through the exact RMUX pane', async () => {
    const backend = new RmuxBackend(rmuxPaths);

    await expect(backend.input(RMUX_TARGET, 'status\n')).resolves.toBe(true);

    expect(rmuxMocks.sendText).toHaveBeenCalledWith('status\n');
  });

  it('reads persisted RMUX exit evidence', () => {
    rmuxPaths.ensureDirectories();
    fs.writeFileSync(path.join(rmuxRoot, 'state', 'run-a.exit.json'), '{"code":7,"signal":null}\n');
    const backend = new RmuxBackend(rmuxPaths);

    expect(backend.readOutcome('run-a', 'session-a')).toEqual({ code: 7, signal: null });
  });

  it('reports a watch target that cannot be verified', async () => {
    rmuxMocks.displayMessage.mockRejectedValueOnce(new Error('missing pane'));
    const backend = new RmuxBackend(rmuxPaths);

    await expect(backend.watch('run-a', RMUX_TARGET, 'session-a')).resolves.toBeUndefined();

    expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('missing pane'));
  });

  it('refuses invalid tracked pids before contacting RMUX', async () => {
    const backend = new RmuxBackend(rmuxPaths);

    await expect(backend.stop(RMUX_TARGET, 0)).resolves.toBe(false);

    expect(rmuxMocks.capabilities).not.toHaveBeenCalled();
  });

  it('reports a signal failure for the exact tracked pane', async () => {
    processKill.mockImplementationOnce(() => {
      throw new Error('signal denied');
    });
    const backend = new RmuxBackend(rmuxPaths);

    await expect(backend.stop(RMUX_TARGET, RMUX_PID)).resolves.toBe(false);

    expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('signal denied'));
  });

  it('bounds an RMUX close command that never settles', async () => {
    rmuxMocks.sessionKill.mockImplementationOnce(() => new Promise(() => undefined));
    const backend = new RmuxBackend(rmuxPaths);
    const stopping = backend.stop(RMUX_TARGET, RMUX_PID);

    await vi.advanceTimersByTimeAsync(4_100);

    await expect(stopping).resolves.toBe(false);
    expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('Timed out closing RMUX target'));
  });

  it('reports an RMUX input failure', async () => {
    rmuxMocks.sendText.mockRejectedValueOnce(new Error('input closed'));
    const backend = new RmuxBackend(rmuxPaths);

    await expect(backend.input(RMUX_TARGET, 'status\n')).resolves.toBe(false);

    expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('input closed'));
  });

  it('reports malformed persisted exit evidence', () => {
    rmuxPaths.ensureDirectories();
    fs.writeFileSync(path.join(rmuxRoot, 'state', 'run-a.exit.json'), 'not-json\n');
    const backend = new RmuxBackend(rmuxPaths);

    expect(backend.readOutcome('run-a', 'session-a')).toBeUndefined();
    expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('exit metadata'));
  });

  it('tracks an interactive launch by name until completion', async () => {
    rmuxPaneDead = true;
    rmuxMocks.captureText.mockResolvedValueOnce('ready');
    const backend = new RmuxBackend(rmuxPaths);

    const handle = await backend.launch({
      id: 'run-a',
      name: 'interactive-a',
      command: 'echo ready',
      cwd: '/repo',
      sessionId: 'session-a',
      interactive: true,
    });

    expect(backend.get('interactive-a')).toBeDefined();
    await vi.advanceTimersByTimeAsync(2_100);
    await handle?.completion();
    expect(backend.get('interactive-a')).toBeUndefined();
  });

  it('falls back when RMUX launch setup fails and reports cleanup failure', async () => {
    rmuxMocks.cmd.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('launch failed'));
    rmuxMocks.sessionKill.mockRejectedValueOnce(new Error('cleanup failed'));
    const backend = new RmuxBackend(rmuxPaths);

    await expect(
      backend.launch({
        id: 'run-a',
        name: 'run-a',
        command: 'echo done',
        cwd: '/repo',
        sessionId: 'session-a',
        interactive: false,
      }),
    ).resolves.toBeUndefined();

    expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('cleanup failed'));
    expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('launch failed'));
  });

  it('does not close an existing session when new-session fails', async () => {
    rmuxMocks.cmd.mockRejectedValueOnce(new Error('duplicate session'));
    rmuxMocks.sessionKill.mockRejectedValue(new Error('must not close existing session'));
    const backend = new RmuxBackend(rmuxPaths);

    await expect(
      backend.launch({
        id: 'run-a',
        name: 'run-a',
        command: 'echo done',
        cwd: '/repo',
        sessionId: 'session-a',
        interactive: false,
      }),
    ).resolves.toBeUndefined();

    expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('duplicate session'));
    expect(emitWarning).not.toHaveBeenCalledWith(expect.stringContaining('must not close existing session'));
  });

  it('watches a verified pane whose true-style exit has no numeric status', async () => {
    rmuxMocks.displayMessage.mockImplementation(async (format: string) => {
      if (format === '#{pane_id}') return { message: '%1' };
      if (format === '#{pane_dead}:#{pane_dead_status}:#{session_name}')
        return { message: `true:not-a-code:${RMUX_TARGET}` };
      return { message: '' };
    });
    const backend = new RmuxBackend(rmuxPaths);

    const watching = backend.watch('run-a', RMUX_TARGET, 'session-a');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_100);

    await expect(watching).resolves.toEqual({ code: null, signal: null });
    expect(rmuxMocks.sessionKill).toHaveBeenCalled();
  });

  it('returns no warning when exit evidence has not been written', () => {
    const backend = new RmuxBackend(rmuxPaths);

    expect(backend.readOutcome('missing', 'session-a')).toBeUndefined();
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it('reads signaled exit evidence with no numeric code', () => {
    rmuxPaths.ensureDirectories();
    fs.writeFileSync(path.join(rmuxRoot, 'state', 'run-a.exit.json'), '{"code":null,"signal":"SIGTERM"}\n');
    const backend = new RmuxBackend(rmuxPaths);

    expect(backend.readOutcome('run-a', 'session-a')).toEqual({ code: null, signal: 'SIGTERM' });
  });

  it('rejects a non-integer tracked pid before contacting RMUX', async () => {
    const backend = new RmuxBackend(rmuxPaths);

    await expect(backend.stop(RMUX_TARGET, Number.NaN)).resolves.toBe(false);

    expect(rmuxMocks.capabilities).not.toHaveBeenCalled();
  });

  it('falls back safely for every operation when RMUX is unavailable', async () => {
    rmuxMocks.capabilities.mockRejectedValue(new Error('rmux unavailable'));
    const backend = new RmuxBackend(rmuxPaths);

    await expect(
      backend.launch({
        id: 'run-a',
        name: 'run-a',
        command: 'echo done',
        cwd: '/repo',
        sessionId: 'session-a',
        interactive: false,
      }),
    ).resolves.toBeUndefined();
    await expect(backend.stop(RMUX_TARGET, RMUX_PID)).resolves.toBe(false);
    await expect(backend.watch('run-a', RMUX_TARGET, 'session-a')).resolves.toBeUndefined();
    await expect(backend.input(RMUX_TARGET, 'status\n')).resolves.toBe(false);
    expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('rmux unavailable'));
  });

  it.each(['null', '"invalid"'])('rejects non-object exit evidence: %s', (evidence) => {
    rmuxPaths.ensureDirectories();
    fs.writeFileSync(path.join(rmuxRoot, 'state', 'run-a.exit.json'), `${evidence}\n`);
    const backend = new RmuxBackend(rmuxPaths);

    expect(backend.readOutcome('run-a', 'session-a')).toBeUndefined();
  });
});
