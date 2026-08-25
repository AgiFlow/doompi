import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serializeRelaunchHandoff } from '@agimon-ai/doompi-extension-contracts/relaunch-handoff';
import { type AgentSupervisorOptions, superviseAgentRelaunches } from '../../../src/adapters/agentSupervisor.ts';
import type { AgentProcess, AgentProcessOptions, SessionFrame } from '../../../src/types/session.ts';

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

function supervise(overrides: Partial<AgentSupervisorOptions> = {}): {
  agent: AgentProcess;
  relaunchFile: string;
} {
  const relaunchFile = path.join(workDir, 'session.relaunch.json');
  const agent = superviseAgentRelaunches({
    command: 'doompi',
    args: ['--name', 'web', '--mode', 'rpc'],
    cwd: workDir,
    env: {},
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
    const { agent } = supervise();
    const seen: SessionFrame[] = [];
    agent.onFrame((frame) => seen.push(frame));
    spawned[0]?.emit({ type: 'hello' });
    agent.send({ type: 'prompt' });
    expect(seen).toEqual([{ type: 'hello' }]);
    expect(spawned[0]?.received).toEqual([{ type: 'prompt' }]);
    spawned[0]?.exit(0);
    await expect(agent.exited).resolves.toBe(0);
  });

  it('relaunches with the recorded major mode and keeps listeners attached', async () => {
    const { agent, relaunchFile } = supervise();
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
    const { relaunchFile } = supervise({ gracefulExitTimeoutMs: 200 });
    fs.writeFileSync(relaunchFile, serializeRelaunchHandoff({ version: 1, majorMode: 'minimal', operationId: 'op' }));

    // The watcher asks for a graceful end first.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(spawned[0]?.inputEnded).toBe(true);
    expect(spawned[0]?.stopped).toBe(false);

    // An agent that ignores the request is killed, and the relaunch proceeds.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(spawned[0]?.stopped).toBe(true);
    await settled();
    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.options.args).toEqual(['--name', 'web', '--mode', 'rpc', '--major-mode', 'minimal']);
  });

  it('treats a malformed relaunch file as a real exit', async () => {
    const { agent, relaunchFile } = supervise();
    fs.writeFileSync(relaunchFile, 'not json');
    spawned[0]?.exit(1);
    await expect(agent.exited).resolves.toBe(1);
    expect(spawned).toHaveLength(1);
    expect(notices.some((notice) => notice.includes('malformed'))).toBe(true);
  });

  it('never relaunches after stop, even when the file exists', async () => {
    const { agent, relaunchFile } = supervise();
    fs.writeFileSync(relaunchFile, serializeRelaunchHandoff({ version: 1, majorMode: 'minimal', operationId: 'op' }));
    agent.stop();
    await expect(agent.exited).resolves.toBe(0);
    expect(spawned).toHaveLength(1);
  });

  it('clears a relaunch file left behind by a crashed run at startup', () => {
    const relaunchFile = path.join(workDir, 'stale.relaunch.json');
    fs.writeFileSync(relaunchFile, serializeRelaunchHandoff({ version: 1, majorMode: 'minimal', operationId: 'op' }));
    supervise({ relaunchFile });
    expect(fs.existsSync(relaunchFile)).toBe(false);
  });
});
