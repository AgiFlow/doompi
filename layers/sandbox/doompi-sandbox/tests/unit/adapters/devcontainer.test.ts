import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findDevcontainerConfig,
  resolveDevcontainerCli,
  runDevcontainerSession,
} from '../../../src/adapters/devcontainer.ts';
import type { EngineProcessRunner } from '../../../src/types/sandboxHarness.ts';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function repoWith(relative?: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-devc-'));
  directories.push(repoRoot);
  if (relative) {
    const target = path.join(repoRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{"image":"node:22"}');
  }
  return repoRoot;
}

const UP_OK = '{"outcome":"success","containerId":"container-abc"}';

function runner(overrides: Partial<EngineProcessRunner> = {}): EngineProcessRunner & {
  runs: Array<{ command: string; args: string[] }>;
} {
  const runs: Array<{ command: string; args: string[] }> = [];
  return {
    runs,
    run: vi.fn(async (command: string, args: string[]) => {
      runs.push({ command, args });
      return 0;
    }),
    capture: vi.fn(async (command: string) =>
      command === 'devcontainer' ? { exitCode: 0, stdout: UP_OK } : { exitCode: 0, stdout: UP_OK },
    ),
    ...overrides,
  } as EngineProcessRunner & { runs: Array<{ command: string; args: string[] }> };
}

function sessionOptions(repoRoot: string, engineRunner: EngineProcessRunner) {
  return {
    repoRoot,
    cwd: repoRoot,
    forwardArgs: ['--major-mode', 'copilot'],
    environment: { DOOMPI_SANDBOX: '1' },
    engine: 'docker' as const,
    runner: engineRunner,
    version: '1.2.3',
    hasTty: false,
  };
}

describe('findDevcontainerConfig', () => {
  it('finds the conventional location', () => {
    const repoRoot = repoWith('.devcontainer/devcontainer.json');

    expect(findDevcontainerConfig(repoRoot)).toBe(path.join(repoRoot, '.devcontainer/devcontainer.json'));
  });

  it('finds the root form', () => {
    const repoRoot = repoWith('.devcontainer.json');

    expect(findDevcontainerConfig(repoRoot)).toBe(path.join(repoRoot, '.devcontainer.json'));
  });

  it('answers undefined for a workspace without one', () => {
    expect(findDevcontainerConfig(repoWith())).toBeUndefined();
  });
});

describe('resolveDevcontainerCli', () => {
  it('prefers an installed CLI over the network', async () => {
    await expect(resolveDevcontainerCli(runner())).resolves.toEqual({ command: 'devcontainer', prefix: [] });
  });

  it('falls back to a pinned npx invocation', async () => {
    const absent = runner({ capture: vi.fn(async () => undefined) });

    const cli = await resolveDevcontainerCli(absent);

    expect(cli.command).toBe('npx');
    expect(cli.prefix[0]).toBe('-y');
    expect(cli.prefix[1]).toMatch(/^@devcontainers\/cli@/);
  });
});

describe('runDevcontainerSession', () => {
  it('brings the container up, installs the distribution, then attaches', async () => {
    const repoRoot = repoWith('.devcontainer/devcontainer.json');
    const engineRunner = runner();

    await expect(runDevcontainerSession(sessionOptions(repoRoot, engineRunner))).resolves.toBe(0);

    const [bootstrap, session] = engineRunner.runs;
    expect(bootstrap?.args.slice(0, 2)).toEqual(['exec', 'container-abc']);
    expect(bootstrap?.args.join(' ')).toContain('npm install -g @agimon-ai/doompi@1.2.3');
    expect(session?.args).toContain('container-abc');
    expect(session?.args.slice(-3)).toEqual(['doompi', '--major-mode', 'copilot']);
  });

  it('reports a container that refused to start', async () => {
    const failing = runner({
      capture: vi.fn(async () => ({ exitCode: 1, stdout: '{"outcome":"error","description":"image pull failed"}' })),
    });

    await expect(runDevcontainerSession(sessionOptions(repoWith(), failing))).rejects.toThrowError(/image pull failed/);
  });

  it('reports a missing CLI rather than launching nothing', async () => {
    const noCli = runner({ capture: vi.fn(async () => undefined) });

    await expect(runDevcontainerSession(sessionOptions(repoWith(), noCli))).rejects.toThrowError(
      /Dev Containers CLI could not be started/,
    );
  });

  it('explains a container that cannot host the distribution', async () => {
    const engineRunner = runner();
    engineRunner.run = vi.fn(async (_command: string, args: string[]) =>
      args[0] === 'exec' && args[1] === 'container-abc' && args.includes('sh') ? 127 : 0,
    );

    await expect(runDevcontainerSession(sessionOptions(repoWith(), engineRunner))).rejects.toThrowError(
      /could not be installed in the dev container/,
    );
  });
});
