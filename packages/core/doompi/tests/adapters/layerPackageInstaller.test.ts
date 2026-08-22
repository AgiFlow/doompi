import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import type { ResolvedPaths } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureLayerPackages,
  ensureManagedPackageManifest,
  missingLayerPackageSpecifiers,
  packageManagerCommandWithStderr,
  SAFE_TRANSITIVE_OVERRIDES,
} from '../../src/adapters/layerPackageInstaller.ts';
import type { ExtensionLayerResolvers } from '../../src/services/extensionAssembler.ts';

const EMPTY_RESOLVED_PATHS: ResolvedPaths = {
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
};
const tempDirectories: string[] = [];

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doompi-layer-packages-'));
  tempDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function config(
  selectedPackages: MajorModesConfig['layers'][string]['packages'],
  defaultPackages?: MajorModesConfig['layers'][string]['packages'],
): MajorModesConfig {
  return {
    ...(defaultPackages
      ? { default: { baseDirectory: '/repo', filePath: '/repo/.doom/modes.yaml', packages: defaultPackages } }
      : {}),
    defaultMajorMode: 'copilot',
    majorMode: {
      copilot: { description: 'Selected fixture mode.', layers: ['selected'] },
    },
    layers: {
      selected: { baseDirectory: '/repo', packages: selectedPackages },
      unselected: { baseDirectory: '/repo', packages: ['@scope/unselected'] },
    },
  };
}

function writeManagedPackage(root: string, name: string, version: string): void {
  const directory = path.join(root, '.pi', 'npm', 'node_modules', ...name.split('/'));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify({ name, version })}\n`);
}

function manifestDependencies(root: string): Record<string, string> {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, '.pi', 'npm', 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  return manifest.dependencies;
}

function resolvers(resolve: (specifier: string) => string[] | undefined): ExtensionLayerResolvers {
  return {
    ownEntry: (name) => `/own/${name}.mjs`,
    packageEntry: (specifier) => `/package/${specifier}`,
    optionalPackageEntry: (specifier) => resolve(specifier)?.[0],
    optionalPackageEntries: resolve,
    localEntry: () => undefined,
  };
}

describe('missingLayerPackageSpecifiers', () => {
  it('selects configured defaults before active layers and deduplicates missing specifiers', () => {
    const modes = config(
      ['@scope/shared/extensions/layer', '@scope/selected'],
      ['@scope/default', '@scope/shared/extensions/default', '@scope/default'],
    );

    expect(
      missingLayerPackageSpecifiers(
        modes,
        ['selected'],
        resolvers(() => undefined),
      ),
    ).toEqual([
      '@scope/default',
      '@scope/shared/extensions/default',
      '@scope/shared/extensions/layer',
      '@scope/selected',
    ]);
  });

  it('selects only unresolved required bare packages from active layers', () => {
    const modes = config([
      '@scope/missing/extensions/pi',
      '@scope/missing/extensions/secondary',
      'plain-missing',
      '@scope/ready',
      '@scope/broken',
      { name: '@scope/optional', optional: true },
      './extensions/local-package',
    ]);
    const resolve = resolvers((specifier) => {
      if (specifier === '@scope/ready') return ['/ready.mjs'];
      if (specifier === '@scope/broken') return [];
      return undefined;
    });

    expect(missingLayerPackageSpecifiers(modes, ['selected'], resolve)).toEqual([
      '@scope/missing/extensions/pi',
      '@scope/missing/extensions/secondary',
      'plain-missing',
    ]);
  });

  it('rejects an unknown selected layer', () => {
    expect(() =>
      missingLayerPackageSpecifiers(
        config([]),
        ['absent'],
        resolvers(() => undefined),
      ),
    ).toThrow('Unknown layer: absent');
  });
});

describe('ensureLayerPackages', () => {
  it('keeps package-manager diagnostics off the structured stdout channel', () => {
    const [command, ...args] = packageManagerCommandWithStderr([
      process.execPath,
      '--eval',
      "process.stdout.write('install output'); process.stderr.write('install warning');",
    ]);
    const result = spawnSync(command!, args, { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('install outputinstall warning');
  });

  it('pins only vulnerable version ranges to non-major repair lines', () => {
    expect(SAFE_TRANSITIVE_OVERRIDES).toEqual({
      '@hono/node-server@2.0.0 - 2.0.9': '^2.0.10',
      '@opentelemetry/core@2.0.0 - 2.7.999': '2.8.0',
      'brace-expansion@5.0.0 - 5.0.8': '^5.0.9',
      'hono@4.0.0 - 4.12.33': '^4.12.34',
      'js-yaml@4.0.0 - 4.3.0': '^4.3.1',
      'js-yaml@5.0.0 - 5.2.1': '^5.2.2',
      'liquidjs@10.0.0 - 10.27.0': '^10.27.1',
      'protobufjs@8.0.0 - 8.7.1': '^8.7.2',
    });
  });
  it('writes the complete secure package graph and installs it with one package-manager call', async () => {
    const root = repository();
    let installed = false;
    const packageManager = {
      install: vi.fn(async () => {
        installed = true;
      }),
      resolveExtensionSources: vi.fn(),
    };
    const resolve = resolvers((specifier) => {
      if (!installed) return undefined;
      if (specifier === '@scope/default/extensions/pi') return ['/managed/default.mjs'];
      if (specifier.startsWith('@scope/missing/')) return [`/managed/${specifier}.mjs`];
      if (specifier === 'plain-missing') return ['/managed/plain-missing.mjs'];
      return undefined;
    });

    await expect(
      ensureLayerPackages(
        {
          repoRoot: root,
          config: config(
            ['@scope/missing/extensions/secondary', 'plain-missing'],
            ['@scope/default/extensions/pi', '@scope/missing/extensions/pi'],
          ),
          layers: ['selected'],
          environment: { PI_CODING_AGENT_DIR: '/agent' },
        },
        { packageManager, resolvers: resolve },
      ),
    ).resolves.toEqual({
      installed: ['npm:@scope/default', 'npm:@scope/missing', 'npm:plain-missing'],
      updated: [],
      unchecked: [],
    });

    expect(packageManager.install).toHaveBeenCalledOnce();
    expect(packageManager.install).toHaveBeenCalledWith('npm:@scope/default', { local: true });
    expect(packageManager.resolveExtensionSources).not.toHaveBeenCalled();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, '.pi', 'npm', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      overrides: Record<string, string>;
      pnpm: { overrides: Record<string, string> };
    };
    expect(manifest.dependencies).toEqual({
      '@scope/default': '*',
      '@scope/missing': '*',
      'plain-missing': '*',
    });
    expect(manifest.overrides).toEqual(SAFE_TRANSITIVE_OVERRIDES);
    expect(manifest.pnpm.overrides).toEqual(SAFE_TRANSITIVE_OVERRIDES);
  });

  it('does not create or call a package manager when every package resolves outside Pi storage', async () => {
    const root = repository();
    const packageManager = { install: vi.fn(), resolveExtensionSources: vi.fn() };

    await expect(
      ensureLayerPackages(
        { repoRoot: root, config: config(['@scope/ready']), layers: ['selected'] },
        { packageManager, resolvers: resolvers(() => ['/ready.mjs']) },
      ),
    ).resolves.toEqual({ installed: [], updated: [], unchecked: [] });

    expect(packageManager.install).not.toHaveBeenCalled();
    expect(packageManager.resolveExtensionSources).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, '.pi', 'npm'))).toBe(false);
  });

  it('reconciles a stale graph once while preserving unrelated policy and removing conflicting rules', async () => {
    const root = repository();
    const manifestPath = path.join(root, '.pi', 'npm', 'package.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        name: 'pi-extensions',
        private: true,
        dependencies: { '@scope/ready': '^1.0.0', custom: '2.0.0' },
        overrides: {
          custom: '2.0.1',
          'hono@^4.0.0': '4.12.1',
          parent: { '.': '1.0.0', hono: '4.12.1', nested: '2.0.0' },
        },
        pnpm: {
          overrides: {
            custom: '2.0.1',
            parent: { hono: '4.12.1', nested: '2.0.0' },
          },
        },
      }),
    );
    const packageManager = { install: vi.fn(), resolveExtensionSources: vi.fn() };
    const dependencies = { packageManager, resolvers: resolvers(() => ['/ready.mjs']) };
    const options = { repoRoot: root, config: config(['@scope/ready']), layers: ['selected'] };

    await expect(ensureLayerPackages(options, dependencies)).resolves.toEqual({
      installed: [],
      updated: [],
      unchecked: [],
    });
    await expect(ensureLayerPackages(options, dependencies)).resolves.toEqual({
      installed: [],
      updated: [],
      unchecked: [],
    });

    expect(packageManager.install).toHaveBeenCalledOnce();
    expect(packageManager.install).toHaveBeenCalledWith('npm:@scope/ready', { local: true });
    expect(packageManager.resolveExtensionSources).not.toHaveBeenCalled();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      dependencies: Record<string, string>;
      overrides: Record<string, unknown>;
      pnpm: { overrides: Record<string, unknown> };
    };
    expect(manifest.dependencies).toEqual({ '@scope/ready': '^1.0.0', custom: '2.0.0' });
    expect(manifest.overrides).toEqual({
      custom: '2.0.1',
      parent: { '.': '1.0.0', nested: '2.0.0' },
      ...SAFE_TRANSITIVE_OVERRIDES,
    });
    expect(manifest.pnpm.overrides).toEqual({
      custom: '2.0.1',
      parent: { nested: '2.0.0' },
      ...SAFE_TRANSITIVE_OVERRIDES,
    });
  });

  it('restores missing modules from an already secure managed manifest', async () => {
    const root = repository();
    let installed = false;
    ensureManagedPackageManifest(root, ['npm:@scope/missing']);
    const packageManager = {
      install: vi.fn(),
      resolveExtensionSources: vi.fn(async () => {
        installed = true;
        return EMPTY_RESOLVED_PATHS;
      }),
    };

    await expect(
      ensureLayerPackages(
        { repoRoot: root, config: config(['@scope/missing']), layers: ['selected'] },
        {
          packageManager,
          resolvers: resolvers(() => (installed ? ['/managed/missing.mjs'] : undefined)),
        },
      ),
    ).resolves.toEqual({ installed: ['npm:@scope/missing'], updated: [], unchecked: [] });

    expect(packageManager.install).not.toHaveBeenCalled();
    expect(packageManager.resolveExtensionSources).toHaveBeenCalledOnce();
    expect(packageManager.resolveExtensionSources).toHaveBeenCalledWith(['npm:@scope/missing'], { local: true });
  });
  it('preserves the package-manager failure as the installation error cause', async () => {
    const root = repository();
    const cause = new Error('registry unavailable');
    const packageManager = { install: vi.fn().mockRejectedValue(cause), resolveExtensionSources: vi.fn() };

    const promise = ensureLayerPackages(
      { repoRoot: root, config: config(['@scope/missing']), layers: ['selected'] },
      { packageManager, resolvers: resolvers(() => undefined) },
    );

    await expect(promise).rejects.toThrow('Failed to reconcile DoomPi layer package(s): npm:@scope/missing');
    await expect(promise).rejects.toMatchObject({ cause });
  });

  it('fails when installation does not expose the configured Pi extension', async () => {
    const root = repository();
    const packageManager = {
      install: vi.fn().mockResolvedValue(undefined),
      resolveExtensionSources: vi.fn().mockResolvedValue(EMPTY_RESOLVED_PATHS),
    };

    await expect(
      ensureLayerPackages(
        {
          repoRoot: root,
          config: config(['@scope/missing/extensions/pi']),
          layers: ['selected'],
        },
        { packageManager, resolvers: resolvers(() => undefined) },
      ),
    ).rejects.toThrow(
      'Installed DoomPi layer package(s) did not expose the configured Pi extension: @scope/missing/extensions/pi',
    );
  });
});

describe('ensureLayerPackages refresh', () => {
  function readyRepository(installedVersion?: string): string {
    const root = repository();
    if (installedVersion) writeManagedPackage(root, '@scope/ready', installedVersion);
    ensureManagedPackageManifest(root, ['npm:@scope/ready']);
    return root;
  }

  it('pins every outdated package to the newest published version and installs the set once', async () => {
    const root = readyRepository('1.0.0');
    const packageManager = { install: vi.fn(), resolveExtensionSources: vi.fn() };
    const progress: string[] = [];

    await expect(
      ensureLayerPackages(
        {
          repoRoot: root,
          config: config(['@scope/ready']),
          layers: ['selected'],
          refresh: true,
          onProgress: (message) => progress.push(message),
        },
        {
          packageManager,
          resolvers: resolvers(() => ['/ready.mjs']),
          publishedVersion: async () => '1.1.0',
        },
      ),
    ).resolves.toEqual({
      installed: [],
      updated: [{ name: '@scope/ready', from: '1.0.0', to: '1.1.0' }],
      unchecked: [],
    });

    expect(packageManager.install).toHaveBeenCalledOnce();
    expect(packageManager.install).toHaveBeenCalledWith('npm:@scope/ready', { local: true });
    // The exact pin is the update: npm keeps the locked version under any range that still admits it.
    expect(manifestDependencies(root)).toEqual({ '@scope/ready': '1.1.0' });
    expect(progress).toEqual(['@scope/ready 1.0.0 -> 1.1.0', 'installing 1 update']);
  });

  it('installs nothing when every managed package already runs the published version', async () => {
    const root = readyRepository('1.0.0');
    const packageManager = { install: vi.fn(), resolveExtensionSources: vi.fn() };

    await expect(
      ensureLayerPackages(
        { repoRoot: root, config: config(['@scope/ready']), layers: ['selected'], refresh: true },
        {
          packageManager,
          resolvers: resolvers(() => ['/ready.mjs']),
          publishedVersion: async () => '1.0.0',
        },
      ),
    ).resolves.toEqual({ installed: [], updated: [], unchecked: [] });

    expect(packageManager.install).not.toHaveBeenCalled();
    expect(packageManager.resolveExtensionSources).not.toHaveBeenCalled();
    expect(manifestDependencies(root)).toEqual({ '@scope/ready': '*' });
  });

  it('keeps the installed version and reports the package when the registry cannot be read', async () => {
    const root = readyRepository('1.0.0');
    const packageManager = { install: vi.fn(), resolveExtensionSources: vi.fn() };
    const progress: string[] = [];

    await expect(
      ensureLayerPackages(
        {
          repoRoot: root,
          config: config(['@scope/ready']),
          layers: ['selected'],
          refresh: true,
          onProgress: (message) => progress.push(message),
        },
        {
          packageManager,
          resolvers: resolvers(() => ['/ready.mjs']),
          publishedVersion: async () => {
            throw new Error('request to registry failed\n  at trace');
          },
        },
      ),
    ).resolves.toEqual({ installed: [], updated: [], unchecked: ['@scope/ready'] });

    expect(packageManager.install).not.toHaveBeenCalled();
    expect(progress).toEqual(['kept @scope/ready 1.0.0: request to registry failed']);
  });

  it('checks only the packages the managed store owns', async () => {
    const root = readyRepository();
    const packageManager = { install: vi.fn(), resolveExtensionSources: vi.fn() };
    const publishedVersion = vi.fn();

    await expect(
      ensureLayerPackages(
        { repoRoot: root, config: config(['@scope/ready']), layers: ['selected'], refresh: true },
        { packageManager, resolvers: resolvers(() => ['/ready.mjs']), publishedVersion },
      ),
    ).resolves.toEqual({ installed: [], updated: [], unchecked: [] });

    expect(publishedVersion).not.toHaveBeenCalled();
    expect(packageManager.install).not.toHaveBeenCalled();
  });
});
