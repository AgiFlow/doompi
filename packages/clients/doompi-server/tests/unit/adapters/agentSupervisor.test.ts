import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeRelaunchHandoff } from '@agimon-ai/doompi-extension-contracts/relaunch-handoff';
import { type AgentSupervisorOptions, superviseAgentRelaunches } from '../../../src/adapters/agentSupervisor.ts';
import { relaunchAgentArgs } from '../../../src/services/serveOptions.ts';
import type { AgentLauncher, AgentProcess, AgentProcessOptions, SessionFrame } from '../../../src/types/session.ts';

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

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-supervisor-'));
});

afterEach(() => {
  spawned.splice(0);
  notices.splice(0);
  fs.rmSync(workDir, { recursive: true, force: true });
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

    // The watcher asks for a graceful end first. Wait for the filesystem event
    // instead of assuming it will arrive within a fixed scheduling window.
    await vi.waitFor(() => expect(spawned[0]?.inputEnded).toBe(true), { timeout: 5_000 });
    expect(spawned[0]?.stopped).toBe(false);

    // An agent that ignores the request is killed, and the relaunch proceeds.
    await vi.waitFor(() => expect(spawned[0]?.stopped).toBe(true), { timeout: 1_000 });
    await settled();
    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.options.args).toEqual(['--name', 'web', '--mode', 'rpc', '--major-mode', 'minimal']);
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
