import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliApp } from '../../src/exports/cli/cliApp';
import { InitCommand } from '../../src/commands/initCommand.ts';
import { SyncPipeline } from '../../src/commands/syncPipeline.ts';

const findRepositoryRoot = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('repository discovery should not run for init');
  }),
);

vi.mock('../../src/exports/utils/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/exports/utils/repository')>()),
  findRepositoryRoot,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('raw CLI entry dispatch', () => {
  it('dispatches init before repository discovery', async () => {
    const execute = vi.spyOn(InitCommand.prototype, 'execute').mockResolvedValue(0);

    await expect(new CliApp().run(['init'])).resolves.toBe(0);
    expect(execute).toHaveBeenCalledWith(['init']);
    expect(findRepositoryRoot).not.toHaveBeenCalled();
  });

  it('advertises init and sync, but not the private build step', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(new CliApp().run(['--help'])).resolves.toBe(0);
    const help = write.mock.calls.flat().join('');
    expect(help).toContain('doompi init');
    expect(help).toContain('doompi sync');
    expect(help).not.toContain('doompi build');
  });

  it('dispatches sync through the build-then-sync pipeline', async () => {
    const execute = vi.spyOn(SyncPipeline.prototype, 'execute').mockResolvedValue(0);

    await expect(new CliApp({} as never).run(['sync', '--major-mode', 'minimal'])).resolves.toBe(0);

    expect(execute).toHaveBeenCalledWith(['sync', '--major-mode', 'minimal']);
    expect(findRepositoryRoot).not.toHaveBeenCalled();
  });

  it('uses repository defaults while honoring environment and flag overrides', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-cli-default-mode-'));
    fs.mkdirSync(path.join(root, '.doom'));
    fs.writeFileSync(
      path.join(root, '.doom', 'modes.yaml'),
      'layers: {}\ndefaultMajorMode: minimal\nmajorMode:\n  minimal: []\n  copilot: []\n  dev: []\n',
    );
    fs.writeFileSync(
      path.join(root, '.doom', 'domains.yaml'),
      'defaultDomains: [development, qa]\ndomains:\n  development:\n    plugins: []\n  qa:\n    plugins: []\naliases: {}\n',
    );
    const previousRoot = process.env.DOOMPI_ROOT;
    const previousMode = process.env.DOOMPI_MAJOR_MODE;
    const previousDomains = process.env.DOOMPI_DOMAINS;
    process.env.DOOMPI_ROOT = root;
    delete process.env.DOOMPI_MAJOR_MODE;
    delete process.env.DOOMPI_DOMAINS;
    const app = new CliApp();
    const runHarness = vi.spyOn(app, 'runHarness').mockResolvedValue(0);

    try {
      await expect(app.run([])).resolves.toBe(0);
      expect(runHarness).toHaveBeenLastCalledWith(
        expect.objectContaining({ repoRoot: root, majorMode: 'minimal', domains: ['development', 'qa'] }),
      );

      process.env.DOOMPI_MAJOR_MODE = 'copilot';
      process.env.DOOMPI_DOMAINS = 'marketing';
      await expect(app.run([])).resolves.toBe(0);
      expect(runHarness).toHaveBeenLastCalledWith(
        expect.objectContaining({ majorMode: 'copilot', domains: ['marketing'] }),
      );

      await expect(app.run(['--major-mode', 'dev', '--domains', 'product,pm'])).resolves.toBe(0);
      expect(runHarness).toHaveBeenLastCalledWith(
        expect.objectContaining({ majorMode: 'dev', domains: ['product', 'pm'] }),
      );
      expect(findRepositoryRoot).not.toHaveBeenCalled();
    } finally {
      if (previousRoot === undefined) delete process.env.DOOMPI_ROOT;
      else process.env.DOOMPI_ROOT = previousRoot;
      if (previousMode === undefined) delete process.env.DOOMPI_MAJOR_MODE;
      else process.env.DOOMPI_MAJOR_MODE = previousMode;
      if (previousDomains === undefined) delete process.env.DOOMPI_DOMAINS;
      else process.env.DOOMPI_DOMAINS = previousDomains;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
