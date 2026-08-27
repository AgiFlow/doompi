import { describe, expect, it, vi } from 'vitest';
import { createCockpitHarness } from '../../../src/adapters/cockpitHarness.ts';
import { cockpitImageTag } from '../../../src/adapters/sandboxImageTag.ts';
import type { EngineCaptureResult, EngineProcessRunner } from '../../../src/types/sandboxHarness.ts';

const TAG = cockpitImageTag('9.9.9');
const CONTAINER_ID = 'c0ffee1234';
const WORKSPACES = [{ path: '/Users/someone/work' }];

interface Behavior {
  captures?: Record<string, EngineCaptureResult | undefined>;
  runExitCodes?: number[];
}

function fakeRunner(behavior: Behavior = {}): EngineProcessRunner & {
  runs: Array<{ command: string; args: string[] }>;
  captured: string[];
} {
  const runExitCodes = [...(behavior.runExitCodes ?? [])];
  const runs: Array<{ command: string; args: string[] }> = [];
  const captured: string[] = [];
  return {
    runs,
    captured,
    run: vi.fn(async (command: string, args: string[]) => {
      runs.push({ command, args });
      return runExitCodes.shift() ?? 0;
    }),
    capture: vi.fn(async (command: string, args: string[]) => {
      const key = `${command} ${args.join(' ')}`;
      captured.push(key);
      if (behavior.captures && key in behavior.captures) return behavior.captures[key];
      // The detached run answers with the container id; lifecycle commands
      // simply succeed. Everything else is unanswered, which is how an absent
      // engine is expressed.
      if (args[0] === 'run') return { exitCode: 0, stdout: `${CONTAINER_ID}\n` };
      if (args[0] === 'stop' || args[0] === 'rm' || args[0] === 'logs') return { exitCode: 0, stdout: '' };
      return undefined;
    }),
  };
}

const READY: Record<string, EngineCaptureResult> = {
  'docker --version': { exitCode: 0, stdout: 'docker 27' },
  [`docker image inspect ${TAG}`]: { exitCode: 0, stdout: '[]' },
};

function harness(runner: EngineProcessRunner, overrides: { probe?: () => Promise<boolean> } = {}) {
  return createCockpitHarness({
    runner,
    version: '9.9.9',
    probe: overrides.probe ?? (async () => true),
    gitIdentity: () => undefined,
    now: () => 0,
  });
}

describe('starting the cockpit container', () => {
  it('runs detached and reports the container id', async () => {
    const runner = fakeRunner({ captures: READY });
    const started = await harness(runner).startCockpitContainer({
      workspaces: WORKSPACES,
      port: 7433,
      environment: {},
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.handle.containerId).toBe(CONTAINER_ID);
    const run = runner.captured.find((entry) => entry.startsWith('docker run'));
    expect(run).toContain(' -d ');
    expect(run).toContain('127.0.0.1:7433:7433');
  });

  it('builds its own image, not the interactive sandbox one', async () => {
    // Two images on purpose: making every `--sandbox` launch pay for a tunnel
    // client and the web package would be a poor trade.
    const runner = fakeRunner({
      captures: { ...READY, [`docker image inspect ${TAG}`]: { exitCode: 1, stdout: '' } },
    });
    const progress: string[] = [];
    await harness(runner).startCockpitContainer({
      workspaces: WORKSPACES,
      port: 7433,
      environment: {},
      onProgress: (message) => progress.push(message),
    });

    expect(runner.runs[0]?.args.slice(0, 3)).toEqual(['build', '-t', TAG]);
    expect(TAG).toContain('cockpit');
    expect(progress.some((line) => line.startsWith('building'))).toBe(true);
  });

  it('refuses a request that mounts nothing', async () => {
    const started = await harness(fakeRunner({ captures: READY })).startCockpitContainer({
      workspaces: [],
      port: 7433,
      environment: {},
    });
    expect(started).toEqual({ ok: false, error: expect.stringContaining('at least one workspace') });
  });

  it('explains what to install when no engine answers', async () => {
    const started = await harness(fakeRunner({ captures: {} })).startCockpitContainer({
      workspaces: WORKSPACES,
      port: 7433,
      environment: {},
    });
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error).toContain('No container engine found');
  });

  it('refuses an operator flag that would replace the image', async () => {
    const started = await harness(fakeRunner({ captures: READY })).startCockpitContainer({
      workspaces: WORKSPACES,
      port: 7433,
      environment: { DOOMPI_SANDBOX_RUN_FLAGS: 'alpine' },
    });
    expect(started.ok).toBe(false);
  });

  it('reports a build that fails rather than starting anything', async () => {
    const runner = fakeRunner({
      captures: { ...READY, [`docker image inspect ${TAG}`]: { exitCode: 1, stdout: '' } },
      runExitCodes: [1],
    });
    const started = await harness(runner).startCockpitContainer({
      workspaces: WORKSPACES,
      port: 7433,
      environment: {},
    });
    expect(started.ok).toBe(false);
    expect(runner.captured.some((entry) => entry.startsWith('docker run'))).toBe(false);
  });
});

describe('readiness', () => {
  it('waits for the cockpit inside to answer before reporting success', async () => {
    let answers = 0;
    const runner = fakeRunner({ captures: READY });
    const started = await harness(runner, {
      probe: async () => {
        answers += 1;
        return answers > 2;
      },
    }).startCockpitContainer({ workspaces: WORKSPACES, port: 7433, environment: {} });

    expect(started.ok).toBe(true);
    expect(answers).toBe(3);
  });

  it('tears the container down and reports its logs when it never answers', async () => {
    // A container that came up but is not serving is worse than one that did
    // not start, because nothing else reports it.
    const runner = fakeRunner({
      captures: {
        ...READY,
        [`docker logs --tail 20 ${CONTAINER_ID}`]: { exitCode: 0, stdout: 'EADDRINUSE' },
      },
    });
    let clock = 0;
    const started = await createCockpitHarness({
      runner,
      version: '9.9.9',
      probe: async () => false,
      gitIdentity: () => undefined,
      now: () => (clock += 30_000),
    }).startCockpitContainer({ workspaces: WORKSPACES, port: 7433, environment: {} });

    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.error).toContain('EADDRINUSE');
    expect(runner.captured).toContain(`docker stop ${CONTAINER_ID}`);
    expect(runner.captured).toContain(`docker rm -f ${CONTAINER_ID}`);
  });
});

describe('stopping and reaping', () => {
  it('stops and removes, because the run is not --rm', async () => {
    const runner = fakeRunner({ captures: READY });
    const started = await harness(runner).startCockpitContainer({
      workspaces: WORKSPACES,
      port: 7433,
      environment: {},
    });
    if (!started.ok) throw new Error('did not start');
    await started.handle.stop();
    expect(runner.captured).toContain(`docker stop ${CONTAINER_ID}`);
    expect(runner.captured).toContain(`docker rm -f ${CONTAINER_ID}`);
  });

  it('reaps a container left by a process that is gone', async () => {
    const runner = fakeRunner({ captures: { 'docker --version': { exitCode: 0, stdout: 'docker 27' } } });
    await expect(harness(runner).reapCockpitContainer(CONTAINER_ID)).resolves.toBe(true);
    expect(runner.captured).toContain(`docker stop ${CONTAINER_ID}`);
  });

  it('reports nothing reaped when no engine answers', async () => {
    await expect(harness(fakeRunner({ captures: {} })).reapCockpitContainer(CONTAINER_ID)).resolves.toBe(false);
  });
});

describe('git identity', () => {
  it('passes the host committer identity so the agent can commit', async () => {
    const runner = fakeRunner({ captures: READY });
    await createCockpitHarness({
      runner,
      version: '9.9.9',
      probe: async () => true,
      gitIdentity: () => ({ name: 'A Dev', email: 'dev@example.com' }),
      now: () => 0,
    }).startCockpitContainer({ workspaces: WORKSPACES, port: 7433, environment: {} });

    const run = runner.captured.find((entry) => entry.startsWith('docker run')) ?? '';
    expect(run).toContain('GIT_AUTHOR_NAME=A Dev');
    expect(run).not.toContain('SSH_AUTH_SOCK');
  });
});

describe('watching a running container', () => {
  async function started(captures: Record<string, EngineCaptureResult>) {
    const runner = fakeRunner({ captures: { ...READY, ...captures } });
    const outcome = await harness(runner).startCockpitContainer({
      workspaces: WORKSPACES,
      port: 7433,
      environment: {},
    });
    if (!outcome.ok) throw new Error(outcome.error);
    return { runner, handle: outcome.handle };
  }

  it('reports a container the engine still calls running', async () => {
    const { handle } = await started({
      [`docker inspect -f {{.State.Running}} ${CONTAINER_ID}`]: { exitCode: 0, stdout: 'true\n' },
    });
    expect(await handle.alive()).toBe(true);
  });

  it('reports a stopped container as gone', async () => {
    const { handle } = await started({
      [`docker inspect -f {{.State.Running}} ${CONTAINER_ID}`]: { exitCode: 0, stdout: 'false\n' },
    });
    expect(await handle.alive()).toBe(false);
  });

  it('reads a removed container as gone rather than as an error', async () => {
    // `inspect` fails outright for a container that no longer exists, which is
    // the same answer as not running for anyone supervising it.
    const { handle } = await started({
      [`docker inspect -f {{.State.Running}} ${CONTAINER_ID}`]: { exitCode: 1, stdout: 'No such object' },
    });
    expect(await handle.alive()).toBe(false);
  });
});
