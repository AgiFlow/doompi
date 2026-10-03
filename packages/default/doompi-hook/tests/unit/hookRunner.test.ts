import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOOK_TELEMETRY_EVENT } from '../../src/constants/telemetry';
import { createBashHookRunner } from '../../src/services/hookRunner';
import { asSpawn, type FakeChild, fakeChild, type FakeChildOutcome } from '../helpers/childProcess';
import { recordingTelemetry } from '../helpers/telemetry';

const REPO_ROOT = '/repo';
const BROKEN_PIPE = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

interface RunnerHarness {
  spawned: Array<{ command: string; options: Record<string, unknown> }>;
  children: FakeChild[];
  payloads: string[];
  warnings: string[];
  records: ReturnType<typeof recordingTelemetry>['records'];
  runner: ReturnType<typeof createBashHookRunner>;
}

function harness(outcome: FakeChildOutcome, platform: NodeJS.Platform = 'darwin'): RunnerHarness {
  const spawned: RunnerHarness['spawned'] = [];
  const children: FakeChild[] = [];
  const payloads: string[] = [];
  const warnings: string[] = [];
  const { telemetry, records } = recordingTelemetry();
  const runner = createBashHookRunner({
    telemetry,
    platform,
    env: { PATH: '/usr/bin', ORIGINAL_REPO_PATH: '/original' },
    warn: (message) => warnings.push(message),
    spawn: asSpawn((...args) => {
      spawned.push({
        command: (args[1] as string[])[1] ?? '',
        options: args[2] as Record<string, unknown>,
      });
      const child = fakeChild(payloads, outcome);
      children.push(child);
      return child;
    }),
  });
  return { spawned, children, payloads, warnings, records, runner };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('bash hook runner', () => {
  it('writes the payload to stdin and runs the command through a non-login bash', async () => {
    const state = harness({ stdout: '{}\n' });

    await state.runner.run({ command: 'guard' }, { session_id: 'session-1' }, { repoRoot: REPO_ROOT });

    expect(state.spawned[0]?.command).toBe('guard');
    expect(state.spawned[0]?.options).toMatchObject({ cwd: REPO_ROOT, detached: true });
    expect(JSON.parse(state.payloads[0] ?? '{}')).toEqual({ session_id: 'session-1' });
  });

  it('handles a broken pipe emitted while ending stdin without losing the hook decision', async () => {
    const child = fakeChild([], { stdout: '{"decision":"approve"}\n' });
    child.stdin.end = () => {
      child.stdin.emit('error', BROKEN_PIPE);
    };
    const runner = createBashHookRunner({ spawn: asSpawn(() => child) });

    await expect(runner.run({ command: 'guard' }, {}, { repoRoot: REPO_ROOT })).resolves.toEqual({
      decision: { decision: 'approve' },
    });
  });

  it('handles asynchronous stdin EPIPE while waiting for the successful hook exit', async () => {
    const state = harness({ stdout: '{"decision":"block","reason":"no"}\n' });
    const execution = state.runner.run({ command: 'guard' }, {}, { repoRoot: REPO_ROOT });

    expect(() => state.children[0]?.stdin.emit('error', BROKEN_PIPE)).not.toThrow();
    expect(await execution).toEqual({ decision: { decision: 'block', reason: 'no' } });
    expect(state.records).toEqual([]);
    expect(state.warnings).toEqual([]);
  });

  it('keeps reporting the failed hook exit when stdin closes early', async () => {
    const state = harness({ stderr: 'hook dependency missing\n', code: 1 });
    const execution = state.runner.run({ command: 'guard' }, {}, { repoRoot: REPO_ROOT });

    expect(() => state.children[0]?.stdin.emit('error', BROKEN_PIPE)).not.toThrow();
    expect((await execution).failure).toEqual({
      command: 'guard',
      message: 'hook dependency missing',
      reason: 'non_zero_exit',
    });
    expect(state.records).toHaveLength(1);
    expect(state.records[0]?.attributes?.['hook.reason']).toBe('non_zero_exit');
  });

  it.each([{ stdout: '{}\n' }, { error: new Error('spawn unavailable') }])(
    'handles a late broken pipe after the hook has settled: %j',
    async (outcome) => {
      const state = harness(outcome);
      await state.runner.run({ command: 'guard' }, {}, { repoRoot: REPO_ROOT });
      const recordsBeforeError = state.records.slice();
      const warningsBeforeError = state.warnings.slice();

      expect(() => state.children[0]?.stdin.emit('error', BROKEN_PIPE)).not.toThrow();
      expect(state.records).toEqual(recordsBeforeError);
      expect(state.warnings).toEqual(warningsBeforeError);
    },
  );

  it('reports unexpected stdin errors after the hook exits', async () => {
    const state = harness({ stdout: '{}\n' });
    const execution = state.runner.run({ command: 'guard' }, {}, { repoRoot: REPO_ROOT });
    const error = Object.assign(new Error('write EIO'), { code: 'EIO' });

    expect(() => state.children[0]?.stdin.emit('error', error)).not.toThrow();
    expect((await execution).failure).toEqual({
      command: 'guard',
      message: 'write EIO',
      reason: 'stdin_failed',
    });
    expect(state.records).toEqual([
      {
        level: 'error',
        event: HOOK_TELEMETRY_EVENT.hookFailed,
        attributes: { 'hook.reason': 'stdin_failed' },
      },
    ]);
    expect(state.warnings[0]).toContain('could not write stdin');
  });

  it('survives a real hook closing stdin before consuming a large payload', async () => {
    const runner = createBashHookRunner();
    const outcome = await runner.run(
      { command: `exec 0<&-; printf '%s\\n' '{"decision":"approve"}'` },
      { tool_response: 'x'.repeat(1024 * 1024) },
      { repoRoot: process.cwd() },
    );

    expect(outcome).toEqual({ decision: { decision: 'approve' } });
  });

  it('exports the repository root and only sets CLAUDE_PLUGIN_ROOT when the hook has one', async () => {
    const withPlugin = harness({ stdout: '{}\n' });
    await withPlugin.runner.run({ command: 'guard' }, {}, { repoRoot: REPO_ROOT, pluginRoot: '/plugins/review' });
    const withoutPlugin = harness({ stdout: '{}\n' });
    await withoutPlugin.runner.run({ command: 'guard' }, {}, { repoRoot: REPO_ROOT });

    expect(withPlugin.spawned[0]?.options.env).toMatchObject({
      CLAUDE_PROJECT_DIR: REPO_ROOT,
      CODEX_REPO_ROOT: REPO_ROOT,
      // Inherited rather than overwritten: a worktree keeps pointing at its origin.
      ORIGINAL_REPO_PATH: '/original',
      CLAUDE_PLUGIN_ROOT: '/plugins/review',
    });
    expect(withoutPlugin.spawned[0]?.options.env).not.toHaveProperty('CLAUDE_PLUGIN_ROOT');
  });

  it('falls back to the repository root when the environment names no original path', async () => {
    const spawned: Array<Record<string, unknown>> = [];
    const runner = createBashHookRunner({
      platform: 'darwin',
      env: {},
      spawn: asSpawn((...args) => {
        spawned.push(args[2] as Record<string, unknown>);
        return fakeChild([], { stdout: '{}\n' });
      }),
    });

    await runner.run({ command: 'guard' }, {}, { repoRoot: REPO_ROOT });

    expect(spawned[0]?.env).toMatchObject({ ORIGINAL_REPO_PATH: REPO_ROOT });
  });

  it('reads the last JSON line the hook printed', async () => {
    const state = harness({ stdout: 'chatter\n{"decision":"approve"}\n{"decision":"block","reason":"no"}\n' });

    const outcome = await state.runner.run({ command: 'guard' }, {}, { repoRoot: REPO_ROOT });

    expect(outcome.decision).toEqual({ decision: 'block', reason: 'no' });
  });

  it('treats output with no JSON line as a hook with no opinion', async () => {
    const state = harness({ stdout: 'plain advisory output\n' });

    expect(await state.runner.run({ command: 'guard' }, {}, { repoRoot: REPO_ROOT })).toEqual({});
    expect(state.records).toEqual([]);
  });

  it('reports unparseable JSON rather than dropping the opinion silently', async () => {
    const state = harness({ stdout: '{invalid-json}\n' });

    const outcome = await state.runner.run({ command: 'guard' }, {}, { repoRoot: REPO_ROOT });

    expect(outcome.failure?.reason).toBe('invalid_json');
    expect(state.records).toEqual([
      {
        level: 'warning',
        event: HOOK_TELEMETRY_EVENT.hookFailed,
        attributes: { 'hook.reason': 'invalid_json' },
      },
    ]);
    expect(state.warnings[0]).toContain('returned invalid JSON');
  });

  it('reports a non-zero exit using stderr as the message', async () => {
    const state = harness({ stderr: 'hook dependency missing\n', code: 1 });

    const outcome = await state.runner.run({ command: 'guard' }, {}, { repoRoot: REPO_ROOT });

    expect(outcome.failure).toEqual({
      command: 'guard',
      message: 'hook dependency missing',
      reason: 'non_zero_exit',
    });
    expect(state.records[0]?.attributes).toEqual({ 'hook.reason': 'non_zero_exit', 'hook.exit_code': 1 });
  });

  it('names the exit code when a failing hook said nothing on stderr', async () => {
    const state = harness({ code: 2 });

    const outcome = await state.runner.run({ command: 'guard' }, {}, { repoRoot: REPO_ROOT });

    expect(outcome.failure?.message).toBe('Advisory hook exited with code 2');
  });

  it('describes an exit with no code at all', async () => {
    const state = harness({ code: null });

    const outcome = await state.runner.run({ command: 'guard' }, {}, { repoRoot: REPO_ROOT });

    expect(outcome.failure?.message).toBe('Advisory hook exited with code unknown');
    expect(state.records[0]?.attributes).toEqual({ 'hook.reason': 'non_zero_exit', 'hook.exit_code': -1 });
  });

  it('reports a hook that could not be spawned at all', async () => {
    const state = harness({ error: new Error('spawn unavailable') });

    const outcome = await state.runner.run({ command: 'guard' }, {}, { repoRoot: REPO_ROOT });

    expect(outcome.failure).toEqual({
      command: 'guard',
      message: 'spawn unavailable',
      reason: 'spawn_failed',
    });
    expect(state.records[0]?.level).toBe('error');
  });

  it('terminates the stalled hook process group, escalates, then reports the timeout', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const state = harness({ stalled: true, pid: 43_210 });

    const execution = state.runner.run({ command: 'stalled-hook', timeout: 1 }, {}, { repoRoot: REPO_ROOT });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill).toHaveBeenCalledWith(-43_210, 'SIGTERM');

    await vi.advanceTimersByTimeAsync(2_000);
    const outcome = await execution;

    expect(kill).toHaveBeenCalledWith(-43_210, 0);
    expect(kill).toHaveBeenCalledWith(-43_210, 'SIGKILL');
    expect(kill).not.toHaveBeenCalledWith(43_210, expect.anything());
    expect(outcome.failure).toEqual({
      command: 'stalled-hook',
      message: 'Hook timed out after 1 seconds.',
      reason: 'timeout',
    });
    expect(state.records[0]?.attributes).toEqual({ 'hook.reason': 'timeout', 'hook.exit_code': -1 });
    kill.mockRestore();
  });

  it('does not escalate to SIGKILL once the group is gone', async () => {
    vi.useFakeTimers();
    const missing = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) throw missing;
      return true;
    });
    const state = harness({ stalled: true, pid: 43_211 });

    const execution = state.runner.run({ command: 'stalled-hook', timeout: 1 }, {}, { repoRoot: REPO_ROOT });
    await vi.advanceTimersByTimeAsync(3_000);
    await execution;

    expect(kill).not.toHaveBeenCalledWith(-43_211, 'SIGKILL');
    expect(state.warnings[0]).toContain('advisory hook timed out');
    kill.mockRestore();
  });

  it('reports the exit code the child had already returned when the timeout fired', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const payloads: string[] = [];
    let child: FakeChild | undefined;
    const { telemetry, records } = recordingTelemetry();
    const runner = createBashHookRunner({
      telemetry,
      platform: 'darwin',
      env: {},
      warn: () => undefined,
      spawn: asSpawn(() => {
        child = fakeChild(payloads, { stalled: true, pid: 43_212 });
        return child;
      }),
    });

    const execution = runner.run({ command: 'stalled-hook', timeout: 1 }, {}, { repoRoot: REPO_ROOT });
    await vi.advanceTimersByTimeAsync(1_000);
    // The hook died to SIGTERM before the escalation window closed.
    child?.emit('exit', 137);
    await vi.advanceTimersByTimeAsync(2_000);
    const outcome = await execution;

    expect(outcome.failure?.reason).toBe('timeout');
    expect(records[0]?.attributes).toEqual({ 'hook.reason': 'timeout', 'hook.exit_code': 137 });
    kill.mockRestore();
  });

  it('signals the process itself where there are no process groups', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const state = harness({ stalled: true, pid: 43_213 }, 'win32');

    const execution = state.runner.run({ command: 'stalled-hook', timeout: 1 }, {}, { repoRoot: REPO_ROOT });
    await vi.advanceTimersByTimeAsync(3_000);
    const outcome = await execution;

    // kill() on the double emits exit, so the escalation finds it already gone.
    expect(kill).not.toHaveBeenCalled();
    expect(state.spawned[0]?.options.detached).toBe(false);
    expect(outcome.failure?.reason).toBe('timeout');
    kill.mockRestore();
  });

  it('warns rather than throwing when the hook process cannot be signalled', async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('operation not permitted');
    });
    const emitWarning = vi.spyOn(process, 'emitWarning').mockReturnValue(undefined);
    const state = harness({ stalled: true, pid: 43_214 });

    const execution = state.runner.run({ command: 'stalled-hook', timeout: 1 }, {}, { repoRoot: REPO_ROOT });
    await vi.advanceTimersByTimeAsync(3_000);

    expect((await execution).failure?.reason).toBe('timeout');
    expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('Could not signal repository hook process'));
    kill.mockRestore();
    emitWarning.mockRestore();
  });
});
