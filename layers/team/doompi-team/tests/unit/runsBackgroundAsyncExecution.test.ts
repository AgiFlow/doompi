import { beforeEach, describe, expect, it } from 'vitest';

import { AsyncSubagentSpawner, type AsyncSubagentSpawnInput } from '../../src/services/asyncExecution';
import { ExternalProcessIpc, type ExternalProcessEndpoint } from '../../src/services/externalProcessIpc';
import type { SessionScope } from '../../src/services/sessionPaths';
import {
  SpawnHandshake,
  type SpawnHandshakeContract,
  type SpawnHandshakeOutcome,
} from '../../src/services/spawnHandshake';
import { SUBAGENT_ROOT_SESSION_ENV, SUBAGENT_RUN_ID_ENV } from '../../src/types/environment';
import { TEST_SESSION_SCOPE } from '../support/sessionScope';

type SendHook = (message: object) => void | Promise<void>;

function channel(): {
  endpoint: ExternalProcessEndpoint;
  sent: object[];
  emit: (message: unknown) => void;
  listenerCount: () => number;
  disconnectCalls: number;
  sendHook?: SendHook;
  sendError?: Error;
} {
  const messageHandlers = new Set<(message: unknown) => void>();
  const sent: object[] = [];
  let disconnectCalls = 0;
  let sendHook: SendHook | undefined;
  let sendError: Error | undefined;

  const endpoint: ExternalProcessEndpoint = {
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onExit() {
      return () => undefined;
    },
    async send(message) {
      sent.push(message);
      if (sendError) throw sendError;
      await sendHook?.(message);
    },
    disconnect() {
      disconnectCalls += 1;
    },
  };

  return {
    endpoint,
    sent,
    emit: (message) => {
      for (const handler of messageHandlers) handler(message);
    },
    listenerCount: () => messageHandlers.size,
    get disconnectCalls() {
      return disconnectCalls;
    },
    get sendHook() {
      return sendHook;
    },
    set sendHook(value: SendHook | undefined) {
      sendHook = value;
    },
    get sendError() {
      return sendError;
    },
    set sendError(value: Error | undefined) {
      sendError = value;
    },
  };
}

class ScriptedSpawnHandshake implements SpawnHandshakeContract {
  static nextOutcome: SpawnHandshakeOutcome = { status: 'signalled' };
  static cancelReason: string | undefined;

  waitForHandshake() {
    return {
      promise: Promise.resolve(ScriptedSpawnHandshake.nextOutcome),
      cancel: (reason: string) => {
        ScriptedSpawnHandshake.cancelReason = reason;
      },
    };
  }
}

class TestAsyncSubagentSpawner extends AsyncSubagentSpawner {
  readonly processChannel = channel();
  readonly ipc: ExternalProcessIpc;
  readonly spawnCalls: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
  scriptedHandshake = false;

  constructor() {
    const externalProcesses = new ExternalProcessIpc();
    super(externalProcesses);
    this.ipc = externalProcesses;
  }

  protected override createSpawnHandshake(): SpawnHandshakeContract {
    return this.scriptedHandshake ? new ScriptedSpawnHandshake() : new SpawnHandshake();
  }

  protected override spawnChild(
    _scope: SessionScope,
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) {
    this.spawnCalls.push({ command, args, cwd: options.cwd, env: options.env });
    return {
      pid: 4242,
      onError: () => undefined,
      onExit: () => undefined,
      onMessage: this.processChannel.endpoint.onMessage,
      send: this.processChannel.endpoint.send,
      disconnect: this.processChannel.endpoint.disconnect,
    };
  }
}

function baseInput(overrides: Partial<AsyncSubagentSpawnInput> = {}): AsyncSubagentSpawnInput {
  const { piArgs: overridePiArgs, sessionScope = TEST_SESSION_SCOPE, ...otherOverrides } = overrides;
  return {
    runId: 'run-1',
    agent: 'worker',
    task: 'Implement the login form validation.',
    cwd: '/tmp/workspace',
    environment: { DOOM_TEAM_TEST_VALUE: 'explicit' },
    childIndex: 0,
    fanout: false,
    runtime: 'claude',
    runtimes: {
      claude: { command: 'external-agent', args: ['--prompt', '{prompt}', '--cwd', '{cwd}'] },
    },
    ...otherOverrides,
    sessionScope,
    piArgs: {
      ...overridePiArgs,
    },
  };
}

beforeEach(() => {
  ScriptedSpawnHandshake.nextOutcome = { status: 'signalled' };
  ScriptedSpawnHandshake.cancelReason = undefined;
});

describe('AsyncSubagentSpawner external-only launch', () => {
  it('launches the CLI runner with explicit environment and signals readiness over IPC', async () => {
    const spawner = new TestAsyncSubagentSpawner();
    spawner.processChannel.sendHook = (message) => {
      if ((message as { kind?: string }).kind !== 'launch') return;
      const launch = message as { runId: string; scopeKey: string };
      spawner.processChannel.emit({
        channel: 'doompi-team-external',
        version: 1,
        direction: 'runner',
        kind: 'ready',
        runId: launch.runId,
        scopeKey: launch.scopeKey,
      });
    };

    const result = await spawner.spawn(baseInput());

    expect(result).toEqual({ runId: 'run-1', pid: 4242 });
    expect(spawner.spawnCalls[0]).toMatchObject({
      command: process.execPath,
      cwd: '/tmp/workspace',
      env: {
        DOOM_TEAM_TEST_VALUE: 'explicit',
        [SUBAGENT_ROOT_SESSION_ENV]: TEST_SESSION_SCOPE.rootSessionId,
        [SUBAGENT_RUN_ID_ENV]: 'run-1',
      },
    });
    expect(spawner.spawnCalls[0]?.args[0]).toMatch(/cliRunnerEntry\.(?:ts|mjs)$/);
    expect(spawner.processChannel.sent[0]).toMatchObject({
      kind: 'launch',
      runId: 'run-1',
      scopeKey: TEST_SESSION_SCOPE.scopeKey,
      config: {
        runtime: 'claude',
        command: 'external-agent',
        args: ['--prompt', 'Implement the login form validation.', '--cwd', '/tmp/workspace'],
        cwd: '/tmp/workspace',
        env: {
          DOOM_TEAM_TEST_VALUE: 'explicit',
          [SUBAGENT_ROOT_SESSION_ENV]: TEST_SESSION_SCOPE.rootSessionId,
          [SUBAGENT_RUN_ID_ENV]: 'run-1',
        },
      },
    });
    expect(spawner.ipc.has(TEST_SESSION_SCOPE, 'run-1')).toBe(true);
  });
});

describe('AsyncSubagentSpawner bounded IPC failure handling', () => {
  it('reports a child startup failure and cleans up the IPC registration', async () => {
    const spawner = new TestAsyncSubagentSpawner();
    spawner.scriptedHandshake = true;
    ScriptedSpawnHandshake.nextOutcome = { status: 'failed', error: 'external agent failed to start' };

    await expect(spawner.spawn(baseInput())).rejects.toThrow('external agent failed to start');

    expect(spawner.ipc.has(TEST_SESSION_SCOPE, 'run-1')).toBe(false);
    expect(spawner.processChannel.listenerCount()).toBe(0);
    expect(spawner.processChannel.disconnectCalls).toBe(1);
  });

  it('reports a bounded handshake timeout and cleans up the IPC registration', async () => {
    const spawner = new TestAsyncSubagentSpawner();
    spawner.scriptedHandshake = true;
    ScriptedSpawnHandshake.nextOutcome = { status: 'timed-out' };

    await expect(spawner.spawn(baseInput({ handshakeTimeoutMs: 25 }))).rejects.toThrow(
      "Timed out waiting for 'worker' (run 'run-1') to start.",
    );

    expect(spawner.ipc.has(TEST_SESSION_SCOPE, 'run-1')).toBe(false);
    expect(spawner.processChannel.listenerCount()).toBe(0);
    expect(spawner.processChannel.disconnectCalls).toBe(1);
  });

  it('cancels the bounded wait and cleans up when the launch message cannot be sent', async () => {
    const spawner = new TestAsyncSubagentSpawner();
    spawner.scriptedHandshake = true;
    spawner.processChannel.sendError = new Error('IPC send failed');

    await expect(spawner.spawn(baseInput())).rejects.toThrow('IPC send failed');

    expect(ScriptedSpawnHandshake.cancelReason).toBe('IPC send failed');
    expect(spawner.ipc.has(TEST_SESSION_SCOPE, 'run-1')).toBe(false);
    expect(spawner.processChannel.listenerCount()).toBe(0);
    expect(spawner.processChannel.disconnectCalls).toBe(1);
  });
});
