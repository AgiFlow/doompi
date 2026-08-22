import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  compileExtensionSet: vi.fn(),
  compileModeExtension: vi.fn(),
  createMapResolvers: vi.fn(),
  extensionSetManifestPath: vi.fn(),
  filterHookDisabledLayers: vi.fn(),
  loadMajorModesConfig: vi.fn(),
  ownEntry: vi.fn(),
  readHarnessState: vi.fn(),
  readSyncState: vi.fn(),
  resolveExtensionComposition: vi.fn(),
  syncDirectory: vi.fn(),
  writeSyncState: vi.fn(),
}));

vi.mock('@agimon-ai/doompi-config/harnessState', () => ({ readHarnessState: mocks.readHarnessState }));
vi.mock('@agimon-ai/doompi-config/majorModes', () => ({
  filterHookDisabledLayers: mocks.filterHookDisabledLayers,
  loadMajorModesConfig: mocks.loadMajorModesConfig,
}));
vi.mock('../../src/services/extensionAssembler.ts', () => ({
  PERSONA_ENTRY: 'persona',
  resolveExtensionComposition: mocks.resolveExtensionComposition,
}));
vi.mock('../../src/adapters/extensionCompiler.ts', () => ({
  compileExtensionSet: mocks.compileExtensionSet,
  extensionSetManifestPath: mocks.extensionSetManifestPath,
}));
vi.mock('../../src/adapters/modules/moduleResolution.ts', () => ({ ownEntry: mocks.ownEntry }));
vi.mock('../../src/adapters/runtimeBundle.ts', () => ({
  compileModeExtension: mocks.compileModeExtension,
}));
vi.mock('../../src/adapters/syncState.ts', () => ({
  createMapResolvers: mocks.createMapResolvers,
  readSyncState: mocks.readSyncState,
  syncDirectory: mocks.syncDirectory,
  writeSyncState: mocks.writeSyncState,
}));

import { buildSyncedRuntime } from '../../src/adapters/syncedRuntimeBuilder.ts';
import { BUNDLED_PRECOMPILE_STRATEGY, PRECOMPILE_STATE_VERSION } from '../../src/adapters/syncStateContract.ts';
import { testMcpProjection } from '../helpers/mcpProjection.ts';

const state = {
  version: 1,
  root: '/repo',
  inputsHash: 'inputs',
  compositionFingerprint: 'fingerprint:copilot:loud',
  selection: { majorMode: 'copilot', domains: ['default'], preset: 'default' },
  env: { DOOMPI_AGENTS: '1' },
  fileState: { profileEnvironment: {}, pluginHooks: [], mcpProjection: testMcpProjection('/repo') },
  resolved: { own: '/source.ts' },
  baseline: { themePath: '/theme.json', themeName: 'doom-pi-dark' },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readSyncState.mockReturnValue(state);
  mocks.readHarnessState.mockReturnValue({
    agents: true,
    mcp: false,
    hooks: true,
    skillDirectories: ['/skills'],
    pluginDirectories: ['/plugin'],
  });
  mocks.loadMajorModesConfig.mockReturnValue({
    defaultMajorMode: 'copilot',
    layers: {},
    majorMode: {
      copilot: { description: 'Full test mode.', layers: ['full'] },
      minimal: { description: 'Minimal test mode.', layers: [] },
    },
  });
  mocks.createMapResolvers.mockReturnValue({
    ownEntry: vi.fn(() => '/own-entry.ts'),
    packageEntry: vi.fn(() => '/persona.mjs'),
  });
  mocks.filterHookDisabledLayers.mockImplementation((_config: unknown, layers: string[]) => layers);
  mocks.resolveExtensionComposition.mockImplementation(
    ({ majorMode, layers, mute }: { majorMode: string; layers: string[]; mute: boolean }) => ({
      parentActivation: [`/${layers[0] ?? 'minimal'}${mute ? '-mute' : ''}.ts`],
      childActivation: ['/child.ts'],
      fingerprint: `fingerprint:${majorMode}:${mute ? 'mute' : 'loud'}`,
    }),
  );
  mocks.extensionSetManifestPath.mockImplementation(
    (_entries: string[], _cache: string, options: { outputName: string }) => `/manifests/${options.outputName}.json`,
  );
  mocks.compileModeExtension.mockImplementation(({ outputName }: { outputName: string }) =>
    Promise.resolve({
      bundle: `/dist/${outputName}.mjs`,
      manifest: `/dist/${outputName}.manifest.json`,
      compilerManifest: `/manifests/${outputName}.json`,
    }),
  );
  mocks.ownEntry.mockReturnValue('/doom.ts');
  mocks.compileExtensionSet.mockResolvedValue('/dist/bootstrap.mjs');
  mocks.syncDirectory.mockReturnValue('/repo/.pi/doom');
  mocks.writeSyncState.mockResolvedValue('/repo/.pi/doom/state.json');
});

describe('buildSyncedRuntime', () => {
  it('builds every mode and atomically publishes the bootstrap freshness record', async () => {
    const result = await buildSyncedRuntime('/repo', { DOOMPI_MCP: '0' });

    expect(mocks.compileModeExtension).toHaveBeenCalledTimes(4);
    expect(result.bundles).toEqual({
      'fingerprint:copilot:loud': '/dist/copilot.mjs',
      'fingerprint:copilot:mute': '/dist/copilot.mute.mjs',
      'fingerprint:minimal:loud': '/dist/minimal.mjs',
      'fingerprint:minimal:mute': '/dist/minimal.mute.mjs',
    });
    expect(result.bundleManifests).toEqual({
      'fingerprint:copilot:loud': '/manifests/copilot.json',
      'fingerprint:copilot:mute': '/manifests/copilot.mute.json',
      'fingerprint:minimal:loud': '/manifests/minimal.json',
      'fingerprint:minimal:mute': '/manifests/minimal.mute.json',
    });
    expect(mocks.compileModeExtension).toHaveBeenCalledWith(
      expect.objectContaining({ compositionFingerprint: expect.stringMatching(/^fingerprint:/) }),
    );
    expect(mocks.compileExtensionSet).toHaveBeenCalledWith(
      ['/doom.ts'],
      path.join('/repo/.pi/doom', 'cache'),
      expect.objectContaining({ outputName: 'bootstrap' }),
    );
    expect(mocks.writeSyncState).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({
        compiled: undefined,
        bundles: result.bundles,
        bootstrap: '/dist/bootstrap.mjs',
        precompile: {
          version: PRECOMPILE_STATE_VERSION,
          strategy: BUNDLED_PRECOMPILE_STRATEGY,
          bootstrapEntry: '/doom.ts',
          bootstrapManifest: '/manifests/bootstrap.json',
          bundleManifests: result.bundleManifests,
        },
      }),
      expect.any(String),
    );
  });

  it('refuses to publish artifacts over synchronization that changed during compilation', async () => {
    mocks.readSyncState
      .mockReturnValueOnce(state)
      .mockReturnValueOnce({ ...state, resolved: { own: '/new-source.ts' } });

    await expect(buildSyncedRuntime('/repo')).rejects.toThrow('synchronization changed while compiling');
    expect(mocks.writeSyncState).not.toHaveBeenCalled();
  });
});
