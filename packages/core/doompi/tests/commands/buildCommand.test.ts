import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessContext } from '../../src/exports/harnessContext';

const mocks = vi.hoisted(() => ({
  buildHarnessContext: vi.fn(),
  buildRuntimeBundle: vi.fn(),
  ensureLayerPackages: vi.fn(),
  findRepositoryRoot: vi.fn(),
  loadDomains: vi.fn(),
  loadMajorModesConfig: vi.fn(),
  parseHarnessArgs: vi.fn(),
  buildSyncedRuntime: vi.fn(),
  computeInputsHash: vi.fn(),
  createLayerResolvers: vi.fn(),
  readSyncState: vi.fn(),
  recordResolvedEntries: vi.fn(),
  selectionEnvironment: vi.fn(),
  syncStateRootMatches: vi.fn(),
  projectRegistersDoom: vi.fn(),
}));

vi.mock('../../src/cli/options', () => ({ parseHarnessArgs: mocks.parseHarnessArgs }));
vi.mock('@agimon-ai/doompi-config/domains', () => ({ loadDomains: mocks.loadDomains }));
vi.mock('@agimon-ai/doompi-config/majorModes', () => ({ loadMajorModesConfig: mocks.loadMajorModesConfig }));
vi.mock('../../src/builders/cli/harnessContext', () => ({ buildHarnessContext: mocks.buildHarnessContext }));
vi.mock('../../src/composition/layerPackageInstaller', () => ({
  ensureLayerPackages: mocks.ensureLayerPackages,
}));
vi.mock('../../src/builders/cli/runtimeBundle', () => ({ buildRuntimeBundle: mocks.buildRuntimeBundle }));
vi.mock('../../src/builders/cli', () => ({
  buildSyncedRuntime: mocks.buildSyncedRuntime,
}));
vi.mock('../../src/composition/syncState', () => ({
  computeInputsHash: mocks.computeInputsHash,
  readSyncState: mocks.readSyncState,
  recordResolvedEntries: mocks.recordResolvedEntries,
  syncStateRootMatches: mocks.syncStateRootMatches,
}));
vi.mock('../../src/builders/cli/extensionAssembler', () => ({
  createLayerResolvers: mocks.createLayerResolvers,
}));
vi.mock('../../src/composition/repository', () => ({
  resolveDoomConfigurationRoot: mocks.findRepositoryRoot,
}));
vi.mock('../../src/cli/commands/sync', () => ({ selectionEnvironment: mocks.selectionEnvironment }));
vi.mock('../../src/builders/cli/projectSettings', () => ({
  DUPLICATE_REGISTRATION_DRIFT: 'duplicate DoomPi registration in .pi/settings.json',
  projectRegistersDoom: mocks.projectRegistersDoom,
}));

import { prepareSync, formatBuildResult } from '../../src/cli/commands/sync/prepare';

function capture(): { output: { write(chunk: string): boolean }; text(): string } {
  const chunks: string[] = [];
  return {
    output: {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
    text: () => chunks.join(''),
  };
}

describe('BuildCommand', () => {
  const cleanup = vi.fn();
  const majorModesConfig = { defaultMajorMode: 'minimal', majorMode: {}, layers: {} };
  const layerResolvers = { localEntry: vi.fn() };
  const resolvedEntries = { 'own:doom': '/package/doom.mjs' };
  const syncedState = {
    root: '/repo',
    compositionFingerprint: 'current-fingerprint',
    inputsHash: 'current-inputs',
    selection: { majorMode: 'copilot', domains: ['default'], preset: 'default' },
    resolved: resolvedEntries,
  };
  const context = {
    options: { repoRoot: '/repo' },
    resources: { skillCount: 4, agentCount: 2 },
    majorModesConfig,
    selectedLayers: ['team'],
    cleanup,
  } as unknown as HarnessContext;

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup.mockResolvedValue(undefined);
    mocks.findRepositoryRoot.mockReturnValue('/repo');
    mocks.loadDomains.mockReturnValue({ defaultDomains: ['development', 'qa'] });
    mocks.loadMajorModesConfig.mockReturnValue({ defaultMajorMode: 'minimal' });
    mocks.selectionEnvironment.mockReturnValue({ DOOMPI_MAJOR_MODE: 'copilot' });
    mocks.parseHarnessArgs.mockReturnValue({ options: { cwd: '/repo', majorMode: 'copilot' } });
    mocks.buildHarnessContext.mockResolvedValue(context);
    mocks.ensureLayerPackages.mockResolvedValue([]);
    mocks.buildRuntimeBundle.mockResolvedValue({
      bundle: '/repo/.pi/doom/dist/copilot.hash.mjs',
      manifest: '/repo/.pi/doom/dist/copilot.hash.manifest.json',
      extensions: ['a', 'b'],
      fingerprint: 'current-fingerprint',
    });
    mocks.readSyncState.mockReturnValue(undefined);
    mocks.computeInputsHash.mockReturnValue('current-inputs');
    mocks.createLayerResolvers.mockReturnValue(layerResolvers);
    mocks.recordResolvedEntries.mockReturnValue(resolvedEntries);
    mocks.syncStateRootMatches.mockReturnValue(true);
    mocks.projectRegistersDoom.mockReturnValue(false);
    mocks.buildSyncedRuntime.mockResolvedValue({
      bootstrap: '/repo/.pi/doom/dist/bootstrap.hash.mjs',
      bundles: { copilot: '/repo/.pi/doom/dist/copilot.hash.mjs' },
      bundleManifests: { copilot: '/repo/.pi/doom/cache/copilot.json' },
    });
  });

  it('warms the selected bundle and always cleans up staged resources', async () => {
    const { output, text } = capture();
    const telemetry = { runInSpan: vi.fn() };

    await expect(
      prepareSync(['build', '--major-mode', 'copilot'], { DOOMPI_ROOT: './repo' }, '/work', output, telemetry as never),
    ).resolves.toBe(0);

    expect(mocks.findRepositoryRoot).not.toHaveBeenCalled();
    expect(mocks.selectionEnvironment).toHaveBeenCalledWith(path.resolve('./repo'), { DOOMPI_ROOT: './repo' });
    expect(mocks.parseHarnessArgs).toHaveBeenCalledWith(
      ['--major-mode', 'copilot'],
      { DOOMPI_MAJOR_MODE: 'copilot' },
      '/work',
      'minimal',
      ['development', 'qa'],
    );
    expect(mocks.buildHarnessContext).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: path.resolve('./repo') }),
      telemetry,
    );
    expect(mocks.ensureLayerPackages).toHaveBeenCalledWith({
      repoRoot: path.resolve('./repo'),
      config: majorModesConfig,
      layers: ['team'],
      environment: { DOOMPI_ROOT: './repo' },
    });
    expect(mocks.ensureLayerPackages.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.buildRuntimeBundle.mock.invocationCallOrder[0]!,
    );
    expect(mocks.buildRuntimeBundle).toHaveBeenCalledWith(context, undefined, expect.any(Object));
    expect(cleanup).toHaveBeenCalledOnce();
    expect(text()).toContain('extensions: 2 -> 1');
    expect(text()).toContain('copilot.hash.manifest.json');
    expect(text()).toContain('skills:     4');
  });

  it('also warms synchronized startup output when sync state is current', async () => {
    mocks.readSyncState.mockReturnValue(syncedState);
    const { output, text } = capture();

    await prepareSync(['build'], { DOOMPI_ROOT: '/repo' }, '/repo', output);

    expect(mocks.computeInputsHash).toHaveBeenCalledWith('/repo', syncedState.selection, expect.any(String));
    expect(mocks.recordResolvedEntries).toHaveBeenCalledWith(majorModesConfig, layerResolvers);
    expect(mocks.buildSyncedRuntime).toHaveBeenCalledWith('/repo', { DOOMPI_ROOT: '/repo' }, expect.any(String));
    expect(text()).toContain('bootstrap.hash.mjs');
    expect(text()).toContain('1 precompiled');
  });

  it('ignores obsolete sync state so the sync pipeline can replace it', async () => {
    mocks.readSyncState.mockImplementation(() => {
      throw new Error('sync state version is obsolete');
    });

    await expect(prepareSync(['build'], { DOOMPI_ROOT: '/repo' }, '/repo', capture().output)).resolves.toBe(0);

    expect(mocks.buildSyncedRuntime).not.toHaveBeenCalled();
  });

  it('skips synchronized startup output when sync state belongs to another repository', async () => {
    mocks.readSyncState.mockReturnValue({ ...syncedState, root: '/other-repository' });
    mocks.syncStateRootMatches.mockReturnValue(false);

    await prepareSync(['build'], { DOOMPI_ROOT: '/repo' }, '/repo', capture().output);

    expect(mocks.syncStateRootMatches).toHaveBeenCalledWith('/repo', '/other-repository');
    expect(mocks.computeInputsHash).not.toHaveBeenCalled();
    expect(mocks.buildSyncedRuntime).not.toHaveBeenCalled();
  });

  it('skips synchronized startup output when the configuration changed', async () => {
    mocks.readSyncState.mockReturnValue({ ...syncedState, inputsHash: 'previous-inputs' });
    const { output, text } = capture();

    await prepareSync(['build'], { DOOMPI_ROOT: '/repo' }, '/repo', output);

    expect(mocks.recordResolvedEntries).not.toHaveBeenCalled();
    expect(mocks.buildSyncedRuntime).not.toHaveBeenCalled();
    expect(text()).not.toContain('bootstrap.hash.mjs');
  });

  it('skips synchronized startup output when the composition fingerprint changed', async () => {
    mocks.readSyncState.mockReturnValue({ ...syncedState, compositionFingerprint: 'previous-fingerprint' });

    await prepareSync(['build'], { DOOMPI_ROOT: '/repo' }, '/repo', capture().output);

    expect(mocks.computeInputsHash).not.toHaveBeenCalled();
    expect(mocks.recordResolvedEntries).not.toHaveBeenCalled();
    expect(mocks.buildSyncedRuntime).not.toHaveBeenCalled();
  });

  it('skips stale package resolution so sync can adopt a local TypeScript extension', async () => {
    mocks.readSyncState.mockReturnValue({
      ...syncedState,
      resolved: { 'pkg:@example/extension': '/repo/node_modules/@example/extension/pi.mjs' },
    });
    mocks.recordResolvedEntries.mockReturnValue({
      'local:/repo/extensions/pi.ts': '/repo/extensions/pi.ts',
    });

    await prepareSync(['build'], { DOOMPI_ROOT: '/repo' }, '/repo', capture().output);

    expect(mocks.buildSyncedRuntime).not.toHaveBeenCalled();
  });

  it('reports a duplicate registration it cannot repair itself', async () => {
    mocks.projectRegistersDoom.mockReturnValue(true);
    const { output, text } = capture();

    await prepareSync(['build'], { DOOMPI_ROOT: '/repo' }, '/repo', output);

    expect(mocks.projectRegistersDoom).toHaveBeenCalledWith('/repo');
    expect(text()).toContain('duplicate DoomPi registration in .pi/settings.json');
    expect(text()).toContain('run doompi sync');
  });

  it('cleans up staged resources when package installation fails', async () => {
    mocks.ensureLayerPackages.mockRejectedValue(new Error('install failed'));

    await expect(prepareSync(['build'], {}, '/work', capture().output)).rejects.toThrow('install failed');

    expect(mocks.buildRuntimeBundle).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('finds the repository and cleans up when compilation fails', async () => {
    mocks.buildRuntimeBundle.mockRejectedValue(new Error('compile failed'));

    await expect(prepareSync(['build'], {}, '/work', capture().output)).rejects.toThrow('compile failed');

    expect(mocks.findRepositoryRoot).toHaveBeenCalledWith('/work', expect.any(String));
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe('formatBuildResult', () => {
  it('reports the persistent artifact and cache counts', () => {
    expect(
      formatBuildResult({
        bundle: '/dist/doom.mjs',
        manifest: '/dist/doom.manifest.json',
        extensionCount: 12,
        skillCount: 3,
        agentCount: 1,
      }),
    ).toContain('/dist/doom.mjs');
  });
});
