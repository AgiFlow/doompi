import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncLocation } from '../../src/adapters/syncLocation.ts';
import type { HarnessContext } from '../../src/exports/services/harnessContext';

const mocks = vi.hoisted(() => ({
  compileExtensionSet: vi.fn(),
  createLayerResolvers: vi.fn(),
  extensionSetManifestPath: vi.fn(),
  resolveExtensionComposition: vi.fn(),
  writeFileAtomic: vi.fn(),
}));

vi.mock('../../src/services/extensionAssembler.ts', () => ({
  createLayerResolvers: mocks.createLayerResolvers,
  resolveExtensionComposition: mocks.resolveExtensionComposition,
}));
vi.mock('../../src/adapters/extensionCompiler.ts', () => ({
  compileExtensionSet: mocks.compileExtensionSet,
  extensionSetManifestPath: mocks.extensionSetManifestPath,
}));
vi.mock('../../src/adapters/serialization/json.ts', () => ({ writeFileAtomic: mocks.writeFileAtomic }));

import {
  buildRuntimeBundle,
  compileModeExtension,
  createRuntimeExtensionPlan,
} from '../../src/adapters/runtimeBundle.ts';

describe('runtime bundle', () => {
  const location = {
    directory: '/home/.pi/.doom/sync/repo/worktrees/repo',
    sharedCacheDirectory: '/home/.pi/.doom/sync/repo/shared-cache',
  } as SyncLocation;
  const context = {
    options: {
      repoRoot: '/repo',
      cwd: '/repo',
      majorMode: 'copilot',
      domains: ['development'],
      profile: 'builder',
      agents: true,
      autoStop: true,
      mute: false,
      preset: 'ollama',
      mcp: true,
    },
    personaEntry: '/persona.ts',
    selectedLayers: ['team'],
    majorModesConfig: { layers: {}, defaultMajorMode: 'copilot', majorMode: {} },
    resources: { skillDirectories: ['/plugins/a/skills/one/SKILL.md'] },
    plugins: [{ directory: '/plugins/a' }],
  } as unknown as HarnessContext;
  const composition = {
    version: 1,
    majorMode: { name: 'copilot' },
    layers: [],
    selections: [],
    parentActivation: ['/first.ts', '/last.ts'],
    childActivation: ['/child.ts'],
    fingerprint: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveExtensionComposition.mockReturnValue(composition);
    mocks.createLayerResolvers.mockReturnValue({});
    mocks.compileExtensionSet.mockResolvedValue(path.join(location.directory, 'dist', 'copilot.hash.mjs'));
    mocks.extensionSetManifestPath.mockReturnValue(path.join(location.directory, 'cache', 'set.manifest.json'));
  });

  it('resolves parent and child activation from one normalized composition', () => {
    expect(createRuntimeExtensionPlan(context)).toEqual({
      extensions: ['/first.ts', '/last.ts'],
      childExtensions: ['/child.ts'],
      fingerprint: composition.fingerprint,
      composition,
    });
    expect(mocks.createLayerResolvers).toHaveBeenCalledWith('/repo');
    expect(mocks.resolveExtensionComposition).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: true,
        autoStop: true,
        majorMode: 'copilot',
        mute: false,
        resolvers: expect.any(Object),
      }),
    );
  });

  it('compiles canonical Pi activation order into a fingerprint-addressed artifact', async () => {
    const built = await buildRuntimeBundle(
      context,
      {
        extensions: ['/first.ts', '/last.ts'],
        childExtensions: ['/child.ts'],
        fingerprint: composition.fingerprint,
        composition,
      },
      location,
    );

    expect(mocks.compileExtensionSet).toHaveBeenCalledWith(
      ['/first.ts', '/last.ts'],
      path.join(location.directory, 'cache'),
      {
        outputDirectory: path.join(location.directory, 'dist'),
        outputName: 'copilot.auto-stop.0123456789ab',
        repositoryRoot: '/repo',
        sharedCacheDirectory: location.sharedCacheDirectory,
      },
    );
    expect(built.bundle).toBe(path.join(location.directory, 'dist', 'copilot.hash.mjs'));
    expect(built.manifest).toBe(path.join(location.directory, 'dist', 'copilot.hash.manifest.json'));
    expect(mocks.writeFileAtomic).toHaveBeenCalledWith(
      built.manifest,
      expect.stringContaining('/plugins/a/skills/one/SKILL.md'),
    );
  });

  it('resolves a plan when the caller does not provide one', async () => {
    await buildRuntimeBundle(context, undefined, location);

    expect(mocks.resolveExtensionComposition).toHaveBeenCalledOnce();
    expect(mocks.compileExtensionSet).toHaveBeenCalledWith(
      ['/first.ts', '/last.ts'],
      path.join(location.directory, 'cache'),
      {
        outputDirectory: path.join(location.directory, 'dist'),
        outputName: 'copilot.auto-stop.0123456789ab',
        repositoryRoot: '/repo',
        sharedCacheDirectory: location.sharedCacheDirectory,
      },
    );
  });

  it('records composition identity and original resource paths beside the artifact', async () => {
    await compileModeExtension({
      repoRoot: '/repo',
      compositionFingerprint: composition.fingerprint,
      selection: {
        majorMode: 'minimal',
        domains: [],
        preset: 'default',
        mute: false,
        autoStop: false,
        agents: false,
        mcp: false,
      },
      extensionPaths: ['/source/one.ts'],
      childExtensionPaths: ['/source/child.ts'],
      skillPaths: ['/source/skills/demo/SKILL.md'],
      pluginRoots: ['/source/plugin'],
    });

    const manifest = JSON.parse(String(mocks.writeFileAtomic.mock.calls.at(-1)?.[1])) as {
      version: number;
      compositionFingerprint: string;
      extensionPaths: string[];
      childExtensionPaths: string[];
      resources: { skillPaths: string[]; pluginRoots: string[] };
    };
    expect(manifest.version).toBe(4);
    expect(manifest.compositionFingerprint).toBe(composition.fingerprint);
    expect(manifest.extensionPaths).toEqual(['/source/one.ts']);
    expect(manifest.childExtensionPaths).toEqual(['/source/child.ts']);
    expect(manifest.resources.skillPaths).toEqual(['/source/skills/demo/SKILL.md']);
    expect(manifest.resources.pluginRoots).toEqual(['/source/plugin']);
  });
});
