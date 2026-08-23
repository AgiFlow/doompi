import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSandboxLauncher } from '../../../src/adapters/harness.ts';
import { sandboxImageTag } from '../../../src/adapters/sandboxImageTag.ts';
import type { EngineCaptureResult, EngineProcessRunner } from '../../../src/types/sandboxHarness.ts';

const TAG = sandboxImageTag('9.9.9');
const noLoginPorts = async (): Promise<number[]> => [];

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function createRepo(modesYaml?: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-sandbox-repo-'));
  tempDirectories.push(repoRoot);
  if (modesYaml !== undefined) {
    fs.mkdirSync(path.join(repoRoot, '.doom'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, '.doom', 'modes.yaml'), modesYaml);
  }
  return repoRoot;
}

interface FakeRunnerBehavior {
  captures?: Record<string, EngineCaptureResult | undefined>;
  runExitCodes?: number[];
}

function fakeRunner(behavior: FakeRunnerBehavior = {}): EngineProcessRunner & {
  runs: Array<{ command: string; args: string[] }>;
} {
  const runExitCodes = [...(behavior.runExitCodes ?? [])];
  const runs: Array<{ command: string; args: string[] }> = [];
  return {
    runs,
    run: vi.fn(async (command: string, args: string[]) => {
      runs.push({ command, args });
      return runExitCodes.shift() ?? 0;
    }),
    capture: vi.fn(async (command: string, args: string[]) => {
      const key = `${command} ${args.join(' ')}`;
      if (behavior.captures && key in behavior.captures) return behavior.captures[key];
      return undefined;
    }),
  };
}

function hostFacts() {
  return {
    hasTty: false,
    platform: 'darwin',
    userId: undefined,
    groupId: undefined,
    repoKey: 'doompi-sandbox-test00000000',
  };
}

describe('createSandboxLauncher', () => {
  it('detects podman when docker is absent and reuses an existing image', async () => {
    const runner = fakeRunner({
      captures: {
        'podman --version': { exitCode: 0, stdout: 'podman 5' },
        [`podman image inspect ${TAG}`]: { exitCode: 0, stdout: '[]' },
      },
    });
    const repoRoot = createRepo();
    const progress: string[] = [];

    const exitCode = await createSandboxLauncher({
      runner,
      version: '9.9.9',
      hostFacts: hostFacts(),
      loginPorts: noLoginPorts,
    }).launchSandbox({
      repoRoot,
      cwd: repoRoot,
      forwardArgs: ['--major-mode', 'copilot'],
      environment: {},
      onProgress: (message) => progress.push(message),
    });

    expect(exitCode).toBe(0);
    expect(progress).toContain('using podman');
    expect(runner.runs).toHaveLength(1);
    expect(runner.runs[0]?.args[0]).toBe('run');
    expect(runner.runs[0]?.args).toContain(TAG);
  });

  it('builds the image once when it is missing', async () => {
    const runner = fakeRunner({
      captures: {
        'docker --version': { exitCode: 0, stdout: 'docker 27' },
        [`docker image inspect ${TAG}`]: { exitCode: 1, stdout: '' },
      },
    });
    const repoRoot = createRepo();

    await createSandboxLauncher({
      runner,
      version: '9.9.9',
      hostFacts: hostFacts(),
      loginPorts: noLoginPorts,
    }).launchSandbox({
      repoRoot,
      cwd: repoRoot,
      forwardArgs: [],
      environment: {},
    });

    expect(runner.runs).toHaveLength(2);
    expect(runner.runs[0]?.args.slice(0, 3)).toEqual(['build', '-t', TAG]);
    expect(runner.runs[0]?.args).toContain('DOOMPI_VERSION=9.9.9');
    expect(runner.runs[1]?.args[0]).toBe('run');
  });

  it('reports a failed image build instead of launching', async () => {
    const runner = fakeRunner({
      captures: {
        'docker --version': { exitCode: 0, stdout: 'docker 27' },
        [`docker image inspect ${TAG}`]: { exitCode: 1, stdout: '' },
      },
      runExitCodes: [1],
    });

    await expect(
      createSandboxLauncher({
        runner,
        version: '9.9.9',
        hostFacts: hostFacts(),
        loginPorts: noLoginPorts,
      }).launchSandbox({
        repoRoot: createRepo(),
        cwd: '/tmp',
        forwardArgs: [],
        environment: {},
      }),
    ).rejects.toThrowError(/Building the sandbox image failed/);
    expect(runner.runs).toHaveLength(1);
  });

  it('falls back through the docker-compatible engines', async () => {
    for (const engine of ['nerdctl', 'finch'] as const) {
      const runner = fakeRunner({
        captures: {
          [`${engine} --version`]: { exitCode: 0, stdout: `${engine} 1.0` },
          [`${engine} image inspect ${TAG}`]: { exitCode: 0, stdout: '[]' },
        },
      });

      await createSandboxLauncher({
        runner,
        version: '9.9.9',
        hostFacts: hostFacts(),
        loginPorts: noLoginPorts,
      }).launchSandbox({
        repoRoot: createRepo(),
        cwd: '/tmp',
        forwardArgs: [],
        environment: {},
      });

      expect(runner.runs[0]?.command).toBe(engine);
    }
  });

  it('passes configured engine options through to the run', async () => {
    const runner = fakeRunner({
      captures: {
        'docker --version': { exitCode: 0, stdout: 'docker 27' },
        [`docker image inspect ${TAG}`]: { exitCode: 0, stdout: '[]' },
      },
    });
    const progress: string[] = [];

    await createSandboxLauncher({
      runner,
      version: '9.9.9',
      hostFacts: hostFacts(),
      loginPorts: noLoginPorts,
    }).launchSandbox({
      repoRoot: createRepo(),
      cwd: '/tmp',
      forwardArgs: [],
      environment: { DOOMPI_SANDBOX_RUN_FLAGS: '--runtime=runsc' },
      onProgress: (message) => progress.push(message),
    });

    expect(runner.runs[0]?.args).toContain('--runtime=runsc');
    expect(progress).toContain('using docker with --runtime=runsc');
  });

  it('refuses configured options that would replace the image', async () => {
    const runner = fakeRunner({ captures: { 'docker --version': { exitCode: 0, stdout: 'docker 27' } } });

    await expect(
      createSandboxLauncher({
        runner,
        version: '9.9.9',
        hostFacts: hostFacts(),
        loginPorts: noLoginPorts,
      }).launchSandbox({
        repoRoot: createRepo(),
        cwd: '/tmp',
        forwardArgs: [],
        environment: { DOOMPI_SANDBOX_RUN_FLAGS: 'alpine' },
      }),
    ).rejects.toThrowError(/would replace|is neither/);
    expect(runner.runs).toEqual([]);
  });

  it('honors the engine override and rejects unknown engines', async () => {
    const runner = fakeRunner();

    await expect(
      createSandboxLauncher({ runner, version: '9.9.9', loginPorts: noLoginPorts }).launchSandbox({
        repoRoot: createRepo(),
        cwd: '/tmp',
        forwardArgs: [],
        environment: { DOOMPI_SANDBOX_ENGINE: 'lxc' },
      }),
    ).rejects.toThrowError(/DOOMPI_SANDBOX_ENGINE must be one of/);
  });

  it('explains what to install when no engine answers', async () => {
    const runner = fakeRunner();

    await expect(
      createSandboxLauncher({ runner, version: '9.9.9', loginPorts: noLoginPorts }).launchSandbox({
        repoRoot: createRepo(),
        cwd: '/tmp',
        forwardArgs: [],
        environment: {},
      }),
    ).rejects.toThrowError(/Install one of docker, podman, nerdctl, finch/);
  });

  it('tags the image with its own distribution version by default', async () => {
    const runner = fakeRunner({
      captures: { 'docker --version': { exitCode: 0, stdout: 'docker 27' } },
    });
    const repoRoot = createRepo();

    await createSandboxLauncher({ runner, hostFacts: hostFacts(), loginPorts: noLoginPorts }).launchSandbox({
      repoRoot,
      cwd: repoRoot,
      forwardArgs: [],
      environment: {},
    });

    const buildArgs = runner.runs[0]?.args ?? [];
    expect(buildArgs[0]).toBe('build');
    expect(buildArgs[2]).toMatch(/^doompi-sandbox:v\d/);
  });

  describe('provider broker', () => {
    function brokeringRunner() {
      return fakeRunner({
        captures: {
          'docker --version': { exitCode: 0, stdout: 'docker 27' },
          [`docker image inspect ${TAG}`]: { exitCode: 0, stdout: '[]' },
        },
      });
    }

    it('starts a broker, wires it into the run, and stops it afterwards', async () => {
      const runner = brokeringRunner();
      const stop = vi.fn().mockResolvedValue(undefined);
      const startBroker = vi.fn().mockResolvedValue({
        endpoint: { transport: 'unix', socketDirectory: '/tmp/broker-abc' },
        token: 'session-token',
        providers: ['anthropic'],
        withheldEnv: ['ANTHROPIC_API_KEY'],
        stop,
      });
      const progress: string[] = [];

      await createSandboxLauncher({
        runner,
        startBroker,
        version: '9.9.9',
        hostFacts: hostFacts(),
        loginPorts: noLoginPorts,
      }).launchSandbox({
        repoRoot: createRepo(),
        cwd: '/tmp',
        forwardArgs: [],
        environment: { ANTHROPIC_API_KEY: 'real-anthropic' },
        onProgress: (message) => progress.push(message),
      });

      expect(startBroker).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
      const runArgs = runner.runs[0]?.args ?? [];
      expect(runArgs).toContain('/tmp/broker-abc:/run/doompi');
      expect(runArgs).toContain('ANTHROPIC_API_KEY=session-token');
      expect(runArgs.join(' ')).not.toContain('real-anthropic');
      expect(progress.some((message) => message.includes('provider keys stay on the host'))).toBe(true);
    });

    it('stops the broker even when the session fails', async () => {
      const runner = brokeringRunner();
      runner.run = vi.fn().mockRejectedValue(new Error('engine died'));
      const stop = vi.fn().mockResolvedValue(undefined);
      const startBroker = vi.fn().mockResolvedValue({
        endpoint: { transport: 'unix', socketDirectory: '/tmp/broker-abc' },
        token: 'session-token',
        providers: ['anthropic'],
        withheldEnv: ['ANTHROPIC_API_KEY'],
        stop,
      });

      await expect(
        createSandboxLauncher({
          runner,
          startBroker,
          version: '9.9.9',
          hostFacts: hostFacts(),
          loginPorts: noLoginPorts,
        }).launchSandbox({
          repoRoot: createRepo(),
          cwd: '/tmp',
          forwardArgs: [],
          environment: {},
        }),
      ).rejects.toThrowError(/engine died/);
      expect(stop).toHaveBeenCalledOnce();
    });

    it('leaves credentials alone when brokering is turned off', async () => {
      const runner = brokeringRunner();
      const startBroker = vi.fn();

      await createSandboxLauncher({
        runner,
        startBroker,
        version: '9.9.9',
        hostFacts: hostFacts(),
        loginPorts: noLoginPorts,
      }).launchSandbox({
        repoRoot: createRepo(),
        cwd: '/tmp',
        forwardArgs: [],
        environment: { DOOMPI_SANDBOX_BROKER: '0', ANTHROPIC_API_KEY: 'real-anthropic' },
      });

      expect(startBroker).not.toHaveBeenCalled();
      expect(runner.runs[0]?.args).toContain('ANTHROPIC_API_KEY=real-anthropic');
    });
  });

  it('warns when the composition declares local workspace packages', async () => {
    const runner = fakeRunner({
      captures: {
        'docker --version': { exitCode: 0, stdout: 'docker 27' },
        [`docker image inspect ${TAG}`]: { exitCode: 0, stdout: '[]' },
      },
    });
    const repoRoot = createRepo('default:\n  packages:\n    - "./packages/local-thing"\n');
    const progress: string[] = [];

    await createSandboxLauncher({
      runner,
      version: '9.9.9',
      hostFacts: hostFacts(),
      loginPorts: noLoginPorts,
    }).launchSandbox({
      repoRoot,
      cwd: repoRoot,
      forwardArgs: [],
      environment: {},
      onProgress: (message) => progress.push(message),
    });

    expect(progress.some((message) => message.includes('local workspace packages'))).toBe(true);
  });
});
