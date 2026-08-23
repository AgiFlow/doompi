import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  configureDpiEnvironment,
  type DpiRunnerDependencies,
  runDpi,
  runDpiInit,
} from '../../src/adapters/dpiRunner.ts';

const temporaryRoots: string[] = [];
const DOOM_CONFIG_FILES = ['config.yaml', 'modes.yaml', 'domains.yaml', 'profiles.yaml'] as const;

function temporaryRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpi-init-'));
  temporaryRoots.push(root);
  return root;
}

function dependencies(): DpiRunnerDependencies {
  return {
    init: vi.fn(() => 0),
    launchPi: vi.fn(async () => 0),
    sync: vi.fn(async () => 0),
    launchSandbox: vi.fn(async () => 0),
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('configureDpiEnvironment', () => {
  it('keeps a CLI-based nested fallback on the same DPI entry point', () => {
    const environment: NodeJS.ProcessEnv = {};

    configureDpiEnvironment(environment, '/installed/doompi/dist/bin/dpi.mjs');

    expect(environment).toEqual({
      PI_CODING_AGENT: 'true',
      AI_AGENT: 'pi',
      PI_SUBAGENT_PI_BINARY: '/installed/doompi/dist/bin/dpi.mjs',
    });
  });

  it('preserves an explicit subagent binary override', () => {
    const environment = { PI_SUBAGENT_PI_BINARY: '/operator/pi' };

    configureDpiEnvironment(environment, '/installed/doompi/dist/bin/dpi.mjs');

    expect(environment.PI_SUBAGENT_PI_BINARY).toBe('/operator/pi');
  });

  it('does not mistake a programmatic host entry for the DPI binary', () => {
    const environment: NodeJS.ProcessEnv = {};

    configureDpiEnvironment(environment, '/workspace/test-runner.mjs');

    expect(environment.PI_SUBAGENT_PI_BINARY).toBeUndefined();
  });
});

describe('runDpi', () => {
  it('forwards Pi arguments without translating or reordering them', async () => {
    const runtime = dependencies();
    const args = ['--provider', 'anthropic', '--model', 'claude-test', 'hello'];

    await expect(runDpi(args, runtime)).resolves.toBe(0);

    expect(runtime.launchPi).toHaveBeenCalledWith(args);
    expect(runtime.init).not.toHaveBeenCalled();
    expect(runtime.sync).not.toHaveBeenCalled();
  });

  it('claims a sandboxed run rather than letting Pi reject the option', async () => {
    const runtime = dependencies();
    vi.mocked(runtime.launchSandbox).mockResolvedValue(4);
    const args = ['--sandbox', '--model', 'claude-test', 'hello'];

    await expect(runDpi(args, runtime)).resolves.toBe(4);

    expect(runtime.launchSandbox).toHaveBeenCalledWith(args);
    expect(runtime.launchPi).not.toHaveBeenCalled();
  });

  it('claims the option wherever it appears in the arguments', async () => {
    const runtime = dependencies();

    await expect(runDpi(['--model', 'claude-test', '--sandbox'], runtime)).resolves.toBe(0);

    expect(runtime.launchSandbox).toHaveBeenCalledOnce();
    expect(runtime.launchPi).not.toHaveBeenCalled();
  });

  it('leaves setup commands with their owners', async () => {
    const runtime = dependencies();

    await runDpi(['sync', '--sandbox'], runtime);
    await runDpi(['init', '--sandbox'], runtime);

    expect(runtime.launchSandbox).not.toHaveBeenCalled();
    expect(runtime.sync).toHaveBeenCalledOnce();
    expect(runtime.init).toHaveBeenCalledOnce();
  });

  it('owns sync instead of forwarding it to Pi', async () => {
    const runtime = dependencies();
    vi.mocked(runtime.sync).mockResolvedValue(7);

    await expect(runDpi(['sync', '--major-mode', 'minimal'], runtime)).resolves.toBe(7);

    expect(runtime.sync).toHaveBeenCalledWith(['sync', '--major-mode', 'minimal']);
    expect(runtime.init).not.toHaveBeenCalled();
    expect(runtime.launchPi).not.toHaveBeenCalled();
  });

  it('owns repository initialization instead of forwarding it to Pi', async () => {
    const runtime = dependencies();
    vi.mocked(runtime.init).mockReturnValue(6);

    await expect(runDpi(['init', '--force'], runtime)).resolves.toBe(6);

    expect(runtime.init).toHaveBeenCalledWith(['init', '--force']);
    expect(runtime.sync).not.toHaveBeenCalled();
    expect(runtime.launchPi).not.toHaveBeenCalled();
  });
});

describe('runDpiInit', () => {
  it('creates repository .doom files without changing project Pi settings', () => {
    const repositoryRoot = temporaryRepository();
    const piDirectory = path.join(repositoryRoot, '.pi');
    const settingsPath = path.join(piDirectory, 'settings.json');
    const settings = '{"theme":"my-theme","extensions":["./mine.ts"]}\n';
    const output = { write: vi.fn(() => true) };
    fs.mkdirSync(piDirectory);
    fs.writeFileSync(settingsPath, settings);

    expect(runDpiInit(['init'], repositoryRoot, output)).toBe(0);

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(settings);
    expect(fs.readdirSync(path.join(repositoryRoot, '.doom')).sort()).toEqual([...DOOM_CONFIG_FILES].sort());
    expect(output.write.mock.calls.flat().join('')).toContain('Run `dpi sync` next.');
  });

  it('preserves edits by default, supports force, and rejects unknown flags', () => {
    const repositoryRoot = temporaryRepository();
    const output = { write: vi.fn(() => true) };
    const configPath = path.join(repositoryRoot, '.doom', 'config.yaml');
    runDpiInit(['init'], repositoryRoot, output);
    fs.writeFileSync(configPath, 'projectTrust: never\n');

    runDpiInit(['init'], repositoryRoot, output);
    expect(fs.readFileSync(configPath, 'utf8')).toBe('projectTrust: never\n');

    runDpiInit(['init', '--force'], repositoryRoot, output);
    expect(fs.readFileSync(configPath, 'utf8')).not.toBe('projectTrust: never\n');
    expect(() => runDpiInit(['init', '--wipe'], repositoryRoot, output)).toThrow('does not accept --wipe');
  });
});
