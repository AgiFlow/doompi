import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeRelaunchHandoff } from '@agimon-ai/doompi-extension-contracts/relaunch-handoff';
import {
  type AgentSupervisorOptions,
  superviseAgentRelaunches,
} from '../../../../src/adapters/server/agentSupervisor.ts';
import { relaunchAgentArgs } from '../../../../src/services/server/serveOptions.ts';
import type {
  AgentLauncher,
  AgentProcess,
  AgentProcessOptions,
  SessionFrame,
} from '../../../../src/types/server/session.ts';

interface FakeChild extends AgentProcess {
  emit(frame: SessionFrame): void;
  exit(code: number): void;
  readonly received: SessionFrame[];
  readonly options: AgentProcessOptions;
  readonly inputEnded: boolean;
  readonly stopped: boolean;
}

function fakeChild(options: AgentProcessOptions): FakeChild {
  const listeners: Array<(frame: SessionFrame) => void> = [];
  const received: SessionFrame[] = [];
  let settle: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => {
    settle = resolve;
  });
  const child = {
    options,
    received,
    inputEnded: false,
    stopped: false,
    send: (frame: SessionFrame) => received.push(frame),
    onFrame: (listener: (frame: SessionFrame) => void) => listeners.push(listener),
    exited,
    endInput: () => {
      child.inputEnded = true;
    },
    stop: () => {
      child.stopped = true;
      settle(0);
    },
    emit: (frame: SessionFrame) => {
      for (const listener of listeners) listener(frame);
    },
    exit: (code: number) => settle(code),
  };
  return child;
}

let workDir: string;
const spawned: FakeChild[] = [];
const notices: string[] = [];
const supervisors: AgentProcess[] = [];

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-supervisor-'));
});

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) {
    supervisor.stop();
    await supervisor.exited;
  }
  spawned.splice(0);
  notices.splice(0);
  fs.rmSync(workDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const BASE_ARGS = ['--name', 'web', '--mode', 'rpc'];

/**
 * Stands in for the composing launcher.
 *
 * It applies the same major-mode rewrite the real one does, so these tests
 * still assert the argument vector the replacement child is spawned with.
 */
function fakeLauncher(): AgentLauncher {
  return {
    resolve: (majorMode) =>
      Promise.resolve({
        command: 'pi',
        args: majorMode === undefined ? [...BASE_ARGS] : relaunchAgentArgs(BASE_ARGS, majorMode),
        cwd: workDir,
        env: {},
      }),
    cleanup: () => Promise.resolve(),
  };
}

async function supervise(overrides: Partial<AgentSupervisorOptions> = {}): Promise<{
  agent: AgentProcess;
  relaunchFile: string;
}> {
  const relaunchFile = path.join(workDir, 'session.relaunch.json');
  const agent = await superviseAgentRelaunches({
    launcher: fakeLauncher(),
    relaunchFile,
    onNotice: (message) => notices.push(message),
    spawn: (options) => {
      const child = fakeChild(options);
      spawned.push(child);
      return child;
    },
    ...overrides,
  });
  supervisors.push(agent);
  return { agent, relaunchFile };
}

/** Resolves once the exit handler's microtask chain has run. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('superviseAgentRelaunches', () => {
  it('fans frames both ways for the current child', async () => {
    const { agent } = await supervise();
    const seen: SessionFrame[] = [];
    agent.onFrame((frame) => seen.push(frame));
    spawned[0]?.emit({ type: 'hello' });
    agent.send({ type: 'prompt' });
    expect(seen).toEqual([{ type: 'hello' }]);
    expect(spawned[0]?.received).toEqual([{ type: 'prompt' }]);
    spawned[0]?.exit(0);
    await expect(agent.exited).resolves.toBe(0);
  });

  it('replays startup frames to every server-side consumer', async () => {
    const { agent } = await supervise();
    spawned[0]?.emit({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'doom-major-mode' });
    spawned[0]?.emit({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'doom-team-agents' });

    const first: SessionFrame[] = [];
    const second: SessionFrame[] = [];
    agent.onFrame((frame) => first.push(frame));
    agent.onFrame((frame) => second.push(frame));

    const startup = [
      { type: 'extension_ui_request', method: 'setStatus', statusKey: 'doom-major-mode' },
      { type: 'extension_ui_request', method: 'setStatus', statusKey: 'doom-team-agents' },
    ];
    expect(first).toEqual(startup);
    expect(second).toEqual(startup);

    spawned[0]?.emit({ type: 'agent_settled' });
    expect(first).toEqual([...startup, { type: 'agent_settled' }]);
    expect(second).toEqual([...startup, { type: 'agent_settled' }]);
  });

  it('relaunches with the recorded major mode and keeps listeners attached', async () => {
    const { agent, relaunchFile } = await supervise();
    const seen: SessionFrame[] = [];
    agent.onFrame((frame) => seen.push(frame));

    fs.writeFileSync(relaunchFile, serializeRelaunchHandoff({ version: 1, majorMode: 'minimal', operationId: 'op' }));
    spawned[0]?.exit(0);
    await settled();

    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.options.args).toEqual(['--name', 'web', '--mode', 'rpc', '--major-mode', 'minimal']);
    expect(fs.existsSync(relaunchFile)).toBe(false);
    expect(notices.some((notice) => notice.includes('minimal'))).toBe(true);

    // The replacement's frames and the client's sends still flow.
    spawned[1]?.emit({ type: 'hello' });
    agent.send({ type: 'prompt' });
    expect(seen).toEqual([{ type: 'hello' }]);
    expect(spawned[1]?.received).toEqual([{ type: 'prompt' }]);

    // A second switch replaces the mode instead of accumulating flags.
    fs.writeFileSync(relaunchFile, serializeRelaunchHandoff({ version: 1, majorMode: 'copilot', operationId: 'op2' }));
    spawned[1]?.exit(0);
    await settled();
    expect(spawned[2]?.options.args).toEqual(['--name', 'web', '--mode', 'rpc', '--major-mode', 'copilot']);

    spawned[2]?.exit(3);
    await expect(agent.exited).resolves.toBe(3);
  });

  it('ends the agent input when the relaunch file appears, and escalates if ignored', async () => {
    const { relaunchFile } = await supervise({ gracefulExitTimeoutMs: 500 });
    fs.writeFileSync(relaunchFile, serializeRelaunchHandoff({ version: 1, majorMode: 'minimal', operationId: 'op' }));

    // Exercise real filesystem monitoring, including the durable-marker fallback.
    await vi.waitFor(() => expect(spawned[0]?.inputEnded).toBe(true), { timeout: 5_000 });
    expect(spawned[0]?.stopped).toBe(false);

    // An agent that ignores the request is killed, and the relaunch proceeds.
    await vi.waitFor(() => expect(spawned[0]?.stopped).toBe(true), { timeout: 1_000 });
    await settled();
    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.options.args).toEqual(['--name', 'web', '--mode', 'rpc', '--major-mode', 'minimal']);
  }, 10_000);

  it.each(['unavailable', 'silent', 'error'] as const)(
    'polls durable requests when the watcher is %s',
    async (mode) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      const nativeWatch = fs.watch;
      const closed = vi.fn();
      let monitor: fs.FSWatcher | undefined;
      vi.spyOn(fs, 'watch').mockImplementation(() => {
        if (mode === 'unavailable') throw new Error('watch unavailable');
        // Keep a real watcher resource but deliberately lose its notifications.
        const watcher = nativeWatch(workDir, () => undefined);
        watcher.on('close', closed);
        monitor = watcher;
        return watcher;
      });
      const { agent, relaunchFile } = await supervise({ gracefulExitTimeoutMs: 500 });
      if (mode === 'error') expect(() => monitor!.emit('error', new Error('watch lost'))).not.toThrow();
      fs.writeFileSync(relaunchFile, serializeRelaunchHandoff({ version: 1, majorMode: 'minimal', operationId: 'op' }));
      await vi.advanceTimersByTimeAsync(100);
      expect(spawned[0]?.inputEnded).toBe(true);
      expect(spawned[0]?.stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(spawned[0]?.stopped).toBe(true);
      expect(spawned).toHaveLength(2);
      expect(spawned[1]?.options.args).toContain('minimal');
      expect(fs.existsSync(relaunchFile)).toBe(false);
      agent.stop();
      await agent.exited;
      await settled();
      expect(vi.getTimerCount()).toBe(0);
      if (mode !== 'unavailable') expect(closed).toHaveBeenCalledOnce();
      if (mode !== 'silent')
        expect(notices).toContain('watching the relaunch request file failed; polling remains active');
    },
  );

  it.each(['resolve', 'spawn'] as const)('allocates no monitoring when initial %s fails', async (stage) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const watch = vi.spyOn(fs, 'watch');
    const failure = new Error('initial launch failed');
    const overrides: Partial<AgentSupervisorOptions> =
      stage === 'resolve'
        ? { launcher: { ...fakeLauncher(), resolve: () => Promise.reject(failure) } }
        : {
            spawn: () => {
              throw failure;
            },
          };
    await expect(supervise(overrides)).rejects.toBe(failure);
    expect(watch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('treats a malformed relaunch file as a real exit', async () => {
    const { agent, relaunchFile } = await supervise();
    fs.writeFileSync(relaunchFile, 'not json');
    spawned[0]?.exit(1);
    await expect(agent.exited).resolves.toBe(1);
    expect(spawned).toHaveLength(1);
    expect(notices.some((notice) => notice.includes('malformed'))).toBe(true);
  });

  it('never relaunches after stop, even when the file exists', async () => {
    const { agent, relaunchFile } = await supervise();
    fs.writeFileSync(relaunchFile, serializeRelaunchHandoff({ version: 1, majorMode: 'minimal', operationId: 'op' }));
    agent.stop();
    await expect(agent.exited).resolves.toBe(0);
    expect(spawned).toHaveLength(1);
  });

  it('does not spawn after stop while relaunch composition is pending', async () => {
    const launcher = fakeLauncher();
    let finishComposition: (() => void) | undefined;
    const { agent, relaunchFile } = await supervise({
      launcher: {
        ...launcher,
        resolve: (majorMode) =>
          majorMode === undefined
            ? launcher.resolve()
            : new Promise((resolve) => {
                finishComposition = () => resolve({ command: 'pi', args: [], cwd: workDir, env: {} });
              }),
      },
    });
    fs.writeFileSync(relaunchFile, serializeRelaunchHandoff({ version: 1, majorMode: 'minimal', operationId: 'op' }));
    spawned[0]?.exit(0);
    await settled();
    expect(finishComposition).toBeTypeOf('function');
    agent.stop();
    await expect(agent.exited).resolves.toBe(0);
    finishComposition!();
    await settled();
    expect(spawned).toHaveLength(1);
    await expect(agent.exited).resolves.toBe(0);
  });

  it('settles and cleans monitoring when replacement spawning fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { agent, relaunchFile } = await supervise({
      spawn: (options) => {
        if (spawned.length > 0) throw new Error('replacement could not spawn');
        const child = fakeChild(options);
        spawned.push(child);
        return child;
      },
    });
    fs.writeFileSync(relaunchFile, serializeRelaunchHandoff({ version: 1, majorMode: 'minimal', operationId: 'op' }));
    spawned[0]?.exit(7);
    await expect(agent.exited).resolves.toBe(7);
    expect(spawned).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(notices.some((notice) => notice.includes('replacement could not spawn'))).toBe(true);
  });

  it('settles on the exit code when the requested mode will not compose', async () => {
    const relaunchFile = path.join(workDir, 'session.relaunch.json');
    const { agent } = await supervise({
      relaunchFile,
      launcher: {
        resolve: (majorMode) =>
          majorMode === undefined
            ? Promise.resolve({ command: 'pi', args: [...BASE_ARGS], cwd: workDir, env: {} })
            : Promise.reject(new Error('modes.yaml is malformed')),
        cleanup: () => Promise.resolve(),
      },
    });

    fs.writeFileSync(relaunchFile, serializeRelaunchHandoff({ version: 1, majorMode: 'minimal', operationId: 'op' }));
    spawned[0]?.exit(2);

    // Nothing to relaunch into, so the agent's own exit code stands rather
    // than the server hanging on a replacement that will never arrive.
    await expect(agent.exited).resolves.toBe(2);
    expect(spawned).toHaveLength(1);
    expect(notices.some((notice) => notice.includes('modes.yaml is malformed'))).toBe(true);
  });

  it('clears a relaunch file left behind by a crashed run at startup', async () => {
    const relaunchFile = path.join(workDir, 'stale.relaunch.json');
    fs.writeFileSync(relaunchFile, serializeRelaunchHandoff({ version: 1, majorMode: 'minimal', operationId: 'op' }));
    await supervise({ relaunchFile });
    expect(fs.existsSync(relaunchFile)).toBe(false);
  });
});
