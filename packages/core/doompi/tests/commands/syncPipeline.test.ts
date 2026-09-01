import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildExecute: vi.fn(),
  ensureLayerPackages: vi.fn(),
  syncExecute: vi.fn(),
  syncOptions: vi.fn(),
}));

vi.mock('../../src/adapters/layerPackageInstaller.ts', () => ({
  ensureLayerPackages: mocks.ensureLayerPackages,
}));

vi.mock('../../src/commands/buildCommand.ts', () => ({
  BuildCommand: class {
    execute = mocks.buildExecute;
  },
}));

vi.mock('../../src/commands/syncCommand.ts', () => ({
  SyncCommand: class {
    execute = mocks.syncExecute;

    constructor(options: unknown) {
      mocks.syncOptions(options);
    }
  },
}));

import { SyncPipeline } from '../../src/commands/syncPipeline.ts';

const environment = { DOOMPI_ROOT: '/repo' };
const output = { write: vi.fn((_chunk: string) => true) };
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe('SyncPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildExecute.mockResolvedValue(0);
    mocks.syncExecute.mockResolvedValue(0);
    mocks.ensureLayerPackages.mockResolvedValue({ installed: [], updated: [], unchecked: [] });
  });

  it('refreshes packages first, then builds, then synchronizes with the requested settings mode', async () => {
    const order: string[] = [];
    mocks.ensureLayerPackages.mockImplementation(async () => {
      order.push('packages');
      return { installed: [], updated: [], unchecked: [] };
    });
    mocks.buildExecute.mockImplementation(async () => {
      order.push('build');
      return 0;
    });
    mocks.syncExecute.mockImplementation(async () => {
      order.push('sync');
      return 0;
    });

    await expect(
      new SyncPipeline({ settingsMode: 'embedded' }).execute(
        ['sync', '--major-mode', 'minimal'],
        environment,
        '/repo',
        output,
      ),
    ).resolves.toBe(0);

    expect(order).toEqual(['packages', 'build', 'sync']);
    expect(mocks.ensureLayerPackages).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: '/repo', refresh: true, environment }),
    );
    expect(mocks.buildExecute).toHaveBeenCalledWith(
      ['build', '--major-mode', 'minimal'],
      environment,
      '/repo',
      expect.any(Object),
    );
    expect(mocks.syncOptions).toHaveBeenCalledWith(
      expect.objectContaining({ settingsMode: 'embedded', lockHeld: true }),
    );
    expect(mocks.syncExecute).toHaveBeenCalledWith(['sync', '--major-mode', 'minimal'], environment, '/repo', output);
  });

  it('uses the global Doom configuration when the current directory has no repository', async () => {
    const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doom-sync-pipeline-global-')));
    temporaryRoots.push(fixture);
    const homeDirectory = path.join(fixture, 'home');
    const globalRoot = path.join(homeDirectory, '.pi', '.doom');
    const currentDirectory = path.join(fixture, 'Documents');
    fs.mkdirSync(globalRoot, { recursive: true });
    fs.mkdirSync(currentDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(globalRoot, 'modes.yaml'),
      'layers: {}\ndefaultMajorMode: minimal\nmajorMode:\n  minimal: []\n',
    );
    const globalEnvironment = { HOME: homeDirectory };

    await expect(
      new SyncPipeline().execute(['sync', '--force'], globalEnvironment, currentDirectory, output),
    ).resolves.toBe(0);

    expect(mocks.ensureLayerPackages).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: globalRoot, environment: globalEnvironment }),
    );
    expect(mocks.buildExecute).toHaveBeenCalledWith(
      ['build', '--force'],
      globalEnvironment,
      currentDirectory,
      expect.any(Object),
    );
    expect(mocks.syncExecute).toHaveBeenCalledWith(['sync', '--force'], globalEnvironment, currentDirectory, output);
  });

  it('keeps check mode read-only by skipping the package refresh and the build', async () => {
    await expect(new SyncPipeline().execute(['sync', '--check'], environment, '/repo', output)).resolves.toBe(0);

    expect(mocks.ensureLayerPackages).not.toHaveBeenCalled();
    expect(mocks.buildExecute).not.toHaveBeenCalled();
    expect(mocks.syncExecute).toHaveBeenCalledOnce();
  });

  it('reports every package that moved to a newer published version', async () => {
    mocks.ensureLayerPackages.mockImplementation(async (options: { onProgress?: (message: string) => void }) => {
      options.onProgress?.('@scope/team 1.0.0 -> 1.1.0');
      return { installed: [], updated: [{ name: '@scope/team', from: '1.0.0', to: '1.1.0' }], unchecked: [] };
    });

    await expect(new SyncPipeline().execute(['sync'], environment, '/repo', output)).resolves.toBe(0);

    const written = output.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(written).toContain('packages: @scope/team 1.0.0 -> 1.1.0');
    expect(written).toContain('packages: updated 1 package');
  });

  it('names the restored and unchecked packages in the step summary', async () => {
    mocks.ensureLayerPackages.mockResolvedValue({
      installed: ['npm:@scope/team'],
      updated: [],
      unchecked: ['@scope/help'],
    });

    await expect(new SyncPipeline().execute(['sync'], environment, '/repo', output)).resolves.toBe(0);

    const written = output.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(written).toContain('packages: installed 1 missing package, 1 package left unchecked');
  });

  it('surfaces the otherwise discarded build report when the build fails', async () => {
    mocks.buildExecute.mockImplementation(
      async (
        _args: string[],
        _environment: NodeJS.ProcessEnv,
        _cwd: string,
        buildOutput: { write(chunk: string): boolean },
      ) => {
        buildOutput.write('extension compile failed\n');
        return 9;
      },
    );

    await expect(new SyncPipeline().execute(['sync'], environment, '/repo', output)).resolves.toBe(9);

    const written = output.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(written).toContain('build:    failed');
    expect(written).toContain('extension compile failed');
  });

  it('does not synchronize after a failed internal build', async () => {
    mocks.buildExecute.mockResolvedValue(9);

    await expect(new SyncPipeline().execute(['sync'], environment, '/repo', output)).resolves.toBe(9);

    expect(mocks.syncExecute).not.toHaveBeenCalled();
  });
});
