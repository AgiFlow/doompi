import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DOOM_SERVER_BUNDLE_FILE } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { loadServerBundle } from '@agimon-ai/doompi-extension-contracts/server-facet';
import { afterEach, describe, expect, it } from 'vitest';
import { compileExtensionModule } from '../../src/services/extensionCompiler';
import { syncServerBundle, type ServerBundleSyncInput } from '../../src/services/serverBundleSync';
import type { ExtensionComposition } from '../../src/services/extensionAssembler';
import { serverBundleIsFresh } from '../../src/services/syncDrift';
import { computeServerSourcesHash } from '../../src/services/syncState';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-server-bundle-'));
  roots.push(root);
  const input: ServerBundleSyncInput = {
    repositoryRoot: root,
    generation: 'test-generation',
    fingerprint: 'a'.repeat(64),
    compositions: [],
    outputDirectory: path.join(root, 'generation', 'api'),
    cacheDirectory: path.join(root, 'generation', 'cache'),
    sharedCacheDirectory: path.join(root, 'shared-cache'),
  };
  return { root, input };
}

function installedPackage(root: string, name: string, scopes = ['session']) {
  const directory = path.join(root, name);
  fs.mkdirSync(path.join(directory, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name,
      doompiServer: { entry: './src/extensions/server.ts', dist: './dist/server.mjs', scopes },
    }),
  );
  const entry = path.join(directory, 'dist', 'pi.mjs');
  fs.writeFileSync(entry, 'export default () => undefined;');
  fs.writeFileSync(path.join(directory, 'dist', 'server.mjs'), 'export default { apply() {} };');
  return { directory, entry };
}

function packageWithServerDependency(root: string, name: string) {
  const pkg = installedPackage(root, name);
  const dependency = path.join(pkg.directory, 'dist', 'dependency.mjs');
  const server = path.join(pkg.directory, 'dist', 'server.mjs');
  fs.writeFileSync(dependency, 'export const value = "before";');
  fs.writeFileSync(server, 'import { value } from "./dependency.mjs"; export default { apply() { return value; } };');
  return { ...pkg, dependency, server };
}

function packageWithRmuxResource(root: string, name: string) {
  const pkg = installedPackage(root, name);
  const resourcePackage = `@agimon-ai/doompi-runner-rmux-${process.platform}-${process.arch}`;
  const resourceDirectory = path.join(root, 'node_modules', ...resourcePackage.split('/'));
  fs.mkdirSync(path.join(resourceDirectory, 'vendor', 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(resourceDirectory, 'package.json'),
    JSON.stringify({ name: resourcePackage, exports: { './package.json': './package.json' } }),
  );
  const binary = path.join(resourceDirectory, 'vendor', 'bin', 'rmux');
  fs.writeFileSync(binary, Buffer.from([0x7f, 0x45, 0x4c, 0x46]), { mode: 0o755 });
  fs.chmodSync(binary, 0o755);
  fs.writeFileSync(
    path.join(pkg.directory, 'package.json'),
    JSON.stringify({
      name,
      optionalDependencies: { [resourcePackage]: 'fixture' },
      doompiServer: { entry: './src/extensions/server.ts', dist: './dist/server.mjs', scopes: ['session'] },
    }),
  );
  fs.writeFileSync(
    path.join(pkg.directory, 'dist', 'server.mjs'),
    `import { createRequire } from 'node:module'; export default { apply() { return createRequire(import.meta.url).resolve('${resourcePackage}/package.json'); } };`,
  );
  return { ...pkg, resourcePackage, resourceDirectory };
}

const installedRequire = createRequire(import.meta.url);

function copyInstalledPackage(manifestPath: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  const source = path.dirname(manifestPath);
  for (const name of fs.readdirSync(source)) {
    if (name === 'node_modules') continue;
    fs.cpSync(path.join(source, name), path.join(destination, name), { recursive: true });
  }
}
function linkInstalledDependencies(manifestPath: string, destinationRoot: string, excluded: ReadonlySet<string>): void {
  const source = path.join(path.dirname(manifestPath), 'node_modules');
  for (const scope of fs.readdirSync(source)) {
    const names = scope.startsWith('@')
      ? fs.readdirSync(path.join(source, scope)).map((name) => `${scope}/${name}`)
      : [scope];
    for (const packageName of names) {
      if (excluded.has(packageName)) continue;
      const sourcePath = path.join(source, packageName);
      const destination = path.join(destinationRoot, 'node_modules', ...packageName.split('/'));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(fs.realpathSync(sourcePath), destination, 'dir');
    }
  }
}

function composition(name: string, entries: string[], layer?: string): ExtensionComposition {
  return {
    version: 4,
    majorMode: { name },
    layers: [],
    selections:
      layer === undefined
        ? []
        : entries.map((entry, index) => ({
            layer,
            layerIndex: 0,
            entryKind: 'package',
            entryIndex: index,
            manifestIndex: 0,
            selector: entry,
            baseDirectory: path.dirname(entry),
            optional: false,
            outcome: 'resolved',
            path: entry,
          })),
    parentActivation: entries,
    childActivation: [],
    fingerprint: 'b'.repeat(64),
  };
}

function loadOptions(input: ServerBundleSyncInput, majorMode: string, activeLayers: string[]) {
  return {
    directory: input.outputDirectory,
    generation: input.generation,
    fingerprint: input.fingerprint,
    majorMode,
    activeLayers,
  };
}

describe('syncServerBundle', () => {
  it.each([false, true])('requires the default server export after compilation (required: %s)', async (required) => {
    const { root, input } = fixture();
    const pkg = installedPackage(root, 'named-only');
    const manifestPath = path.join(pkg.directory, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.doompiServer.required = required;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    fs.writeFileSync(path.join(pkg.directory, 'dist', 'server.mjs'), 'export const serverPlugin = { apply() {} };');
    await syncServerBundle({ ...input, compositions: [composition('coding', [pkg.entry])] });
    const notices: string[] = [];
    const loading = loadServerBundle('session', {
      ...loadOptions(input, 'coding', ['default']),
      onNotice: (message) => notices.push(message),
    });
    if (required) {
      await expect(loading).rejects.toThrow('default export is not a server object facet');
    } else {
      expect((await loading).facets).toEqual([]);
      expect(notices).toEqual([expect.stringContaining('default export is not a server object facet')]);
    }
  });

  it('writes one empty descriptor without route or facet aggregates', async () => {
    const { input } = fixture();
    const { descriptor } = await syncServerBundle(input);
    expect(descriptor.entries).toEqual([]);
    expect(fs.readdirSync(input.outputDirectory)).toEqual([DOOM_SERVER_BUNDLE_FILE]);
  });

  it('deduplicates packages while retaining mode and layer ownership', async () => {
    const { root, input } = fixture();
    const pkg = installedPackage(root, 'shared');
    const { descriptor, compilerManifests } = await syncServerBundle({
      ...input,
      compositions: [composition('coding', [pkg.entry], 'tools'), composition('review', [pkg.entry], 'review-tools')],
    });
    expect(descriptor.entries).toHaveLength(1);
    expect(Object.keys(compilerManifests)).toEqual(['shared']);
    const receipt = JSON.parse(fs.readFileSync(compilerManifests.shared, 'utf8'));
    expect(fs.realpathSync(receipt.output)).toBe(
      fs.realpathSync(path.resolve(input.outputDirectory, descriptor.entries[0]!.module)),
    );
    expect(descriptor.entries[0]?.owners).toEqual([
      { majorMode: 'coding', layer: 'tools' },
      { majorMode: 'review', layer: 'review-tools' },
    ]);
    expect((await loadServerBundle('session', loadOptions(input, 'coding', ['tools']))).facets).toHaveLength(1);
    expect((await loadServerBundle('session', loadOptions(input, 'coding', []))).facets).toEqual([]);
  });

  it('orders candidates and keeps hub facets out of session loading', async () => {
    const { root, input } = fixture();
    const zeta = installedPackage(root, 'zeta', ['global']);
    const alpha = installedPackage(root, 'alpha');
    const { descriptor } = await syncServerBundle({
      ...input,
      compositions: [composition('coding', [zeta.entry, alpha.entry])],
    });
    expect(descriptor.entries.map(({ packageName }) => packageName)).toEqual(['alpha', 'zeta']);
    const loaded = await loadServerBundle('session', loadOptions(input, 'coding', ['default']));
    expect(loaded.facets.map(({ declaration }) => declaration.packageName)).toEqual(['alpha']);
    expect(fs.readdirSync(input.outputDirectory).sort()).toEqual(['modules', DOOM_SERVER_BUNDLE_FILE].sort());
  });

  it('detects server dependency, declaration and artifact drift without importing facets', async () => {
    const { root, input } = fixture();
    const pkg = packageWithServerDependency(root, 'freshness');
    const { descriptor, compilerManifests } = await syncServerBundle({
      ...input,
      compositions: [composition('coding', [pkg.entry])],
    });
    const resolved = { freshness: pkg.entry };
    const descriptorPath = path.join(input.outputDirectory, DOOM_SERVER_BUNDLE_FILE);
    const state = {
      resolved,
      serverBundle: {
        descriptorPath,
        fingerprint: input.fingerprint,
        compilerManifests,
        sourcesHash: computeServerSourcesHash(resolved),
      },
    };
    const registration = {
      generation: input.generation,
      generationRoot: path.dirname(input.outputDirectory),
      serverBundle: { path: descriptorPath, fingerprint: input.fingerprint, sha256: 'unused-by-freshness' },
    };
    expect(serverBundleIsFresh(state, registration)).toBe(true);
    const dependency = fs.readFileSync(pkg.dependency);
    fs.writeFileSync(pkg.dependency, 'export const value = "changed";');
    expect(serverBundleIsFresh(state, registration)).toBe(false);
    fs.writeFileSync(pkg.dependency, dependency);
    expect(serverBundleIsFresh(state, registration)).toBe(true);
    const manifest = path.join(pkg.directory, 'package.json');
    const originalManifest = fs.readFileSync(manifest);
    fs.appendFileSync(manifest, ' ');
    expect(serverBundleIsFresh(state, registration)).toBe(false);
    fs.writeFileSync(manifest, originalManifest);
    expect(serverBundleIsFresh(state, registration)).toBe(true);
    fs.appendFileSync(path.resolve(input.outputDirectory, descriptor.entries[0]!.module), '\n// corrupt');
    expect(serverBundleIsFresh(state, registration)).toBe(false);
  });

  it('compiles built entries when the published package does not ship sources', async () => {
    const { root, input } = fixture();
    const pkg = installedPackage(root, 'published');
    await syncServerBundle({ ...input, compositions: [composition('coding', [pkg.entry])] });
    fs.rmSync(pkg.directory, { recursive: true, force: true });
    const loaded = await loadServerBundle('session', loadOptions(input, 'coding', ['default']));
    expect(typeof loaded.facets[0]?.facet.apply).toBe('function');
  });

  it('keeps directly compiled server graphs usable after fixture source mutation and removal', async () => {
    const { root } = fixture();
    const pkg = packageWithServerDependency(root, 'direct');
    const output = await compileExtensionModule(pkg.server, path.join(root, 'cache'), {
      outputDirectory: path.join(root, 'compiled'),
    });

    fs.writeFileSync(pkg.dependency, 'export const value = "after";');
    fs.rmSync(pkg.directory, { recursive: true, force: true });

    const loaded = (await import(pathToFileURL(output).href)) as { default: { apply(): string } };
    expect(loaded.default.apply()).toBe('before');
  });

  it('keeps synced server graphs usable after fixture source mutation and removal', async () => {
    const { root, input } = fixture();
    const pkg = packageWithServerDependency(root, 'synced');
    await syncServerBundle({ ...input, compositions: [composition('coding', [pkg.entry])] });

    fs.writeFileSync(pkg.dependency, 'export const value = "after";');
    fs.rmSync(pkg.directory, { recursive: true, force: true });

    const loaded = await loadServerBundle('session', loadOptions(input, 'coding', ['default']));
    expect(loaded.facets).toHaveLength(1);
    const facet = loaded.facets[0]?.facet as unknown as { apply(): string };
    expect(facet.apply()).toBe('before');
  });

  it('retains the packaged RMUX executable after its source package is removed', async () => {
    const { root, input } = fixture();
    const pkg = packageWithRmuxResource(root, 'runner-resource');
    await syncServerBundle({ ...input, compositions: [composition('coding', [pkg.entry])] });
    const secondInput = {
      ...input,
      outputDirectory: path.join(root, 'generation-second', 'api'),
      cacheDirectory: path.join(root, 'generation-second', 'cache'),
    };
    await syncServerBundle({ ...secondInput, compositions: [composition('coding', [pkg.entry])] });
    const secondBefore = await loadServerBundle('session', loadOptions(secondInput, 'coding', ['default']));
    const secondFacet = secondBefore.facets[0]?.facet as unknown as { apply(): string };
    expect(secondFacet.apply()).toBe(
      fs.realpathSync(
        path.join(secondInput.outputDirectory, 'modules', '0', 'node_modules', pkg.resourcePackage, 'package.json'),
      ),
    );

    fs.rmSync(pkg.directory, { recursive: true, force: true });
    fs.rmSync(pkg.resourceDirectory, { recursive: true, force: true });
    const loaded = await loadServerBundle('session', loadOptions(input, 'coding', ['default']));
    const facet = loaded.facets[0]?.facet as unknown as { apply(): string };
    const binary = path.join(
      input.outputDirectory,
      'modules',
      '0',
      'node_modules',
      pkg.resourcePackage,
      'vendor',
      'bin',
      'rmux',
    );
    expect(facet.apply()).toBe(
      fs.realpathSync(
        path.join(input.outputDirectory, 'modules', '0', 'node_modules', pkg.resourcePackage, 'package.json'),
      ),
    );
    expect(fs.statSync(binary).mode & 0o777).toBe(0o755);
  });
  it('does not publish when a declared runner runtime dependency is unavailable', async () => {
    const { root, input } = fixture();
    const pkg = packageWithRmuxResource(root, 'runner-fixture');
    const manifestPath = path.join(pkg.directory, 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.dependencies = { '@agimon-ai/doompi-telemetry': '1.0.0' };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    // Block inherited module search paths so this failure is isolated from the host install.
    const telemetry = path.join(pkg.directory, 'node_modules', '@agimon-ai', 'doompi-telemetry');
    fs.mkdirSync(telemetry, { recursive: true });
    fs.writeFileSync(
      path.join(telemetry, 'package.json'),
      JSON.stringify({ name: '@agimon-ai/doompi-telemetry', exports: {} }),
    );
    await expect(syncServerBundle({ ...input, compositions: [composition('coding', [pkg.entry])] })).rejects.toThrow(
      /doompi-telemetry/,
    );
    expect(fs.existsSync(path.join(input.outputDirectory, DOOM_SERVER_BUNDLE_FILE))).toBe(false);
  });

  it('rejects recursive runtime resource symlinks before traversing them', async () => {
    const { root, input } = fixture();
    const pkg = packageWithRmuxResource(root, 'runner-fixture');
    fs.symlinkSync(pkg.directory, path.join(pkg.directory, 'dist', 'cycle'), 'dir');
    await expect(syncServerBundle({ ...input, compositions: [composition('coding', [pkg.entry])] })).rejects.toThrow(
      /runtime resource contains a symlink/i,
    );
    expect(fs.existsSync(path.join(input.outputDirectory, DOOM_SERVER_BUNDLE_FILE))).toBe(false);
  });

  // Copies installed native packages and compiles a real graph alongside the full suite.
  it(
    'retains the installed current-platform RMUX executable after isolated source replacement',
    { timeout: 60_000 },
    async () => {
      const runnerPackage = '@agimon-ai/doompi-runner';
      const resourcePrefix = '@agimon-ai/doompi-runner-rmux-';
      const target = `${process.platform}-${process.arch}`;
      if (!new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']).has(target)) return;
      const resourcePackage = `${resourcePrefix}${target}`;
      const tursoPlatformPackage =
        target === 'darwin-arm64'
          ? '@tursodatabase/database-darwin-arm64'
          : target === 'darwin-x64'
            ? '@tursodatabase/database-darwin-x64'
            : target === 'linux-arm64'
              ? '@tursodatabase/database-linux-arm64-gnu'
              : '@tursodatabase/database-linux-x64-gnu';
      const runnerManifest = installedRequire.resolve(`${runnerPackage}/package.json`);
      const runner = JSON.parse(fs.readFileSync(runnerManifest, 'utf8')) as Record<string, unknown>;
      const optional = runner.optionalDependencies;
      if (optional === null || typeof optional !== 'object' || Array.isArray(optional)) return;
      const runnerRequire = createRequire(runnerManifest);
      const resourceManifests = new Map<string, string>();
      for (const packageName of Object.keys(optional)) {
        if (!packageName.startsWith(resourcePrefix)) continue;
        try {
          resourceManifests.set(packageName, runnerRequire.resolve(`${packageName}/package.json`));
        } catch {
          // Unsupported optional packages are absent from a packed install.
        }
      }
      const currentResourceManifest = resourceManifests.get(resourcePackage);
      if (!currentResourceManifest) throw new Error(`Installed RMUX package is missing for ${target}`);

      const { root, input } = fixture();
      const sourceRoot = path.join(root, 'installed-source');
      const runnerDirectory = path.join(sourceRoot, 'node_modules', ...runnerPackage.split('/'));
      copyInstalledPackage(runnerManifest, runnerDirectory);
      linkInstalledDependencies(
        runnerManifest,
        sourceRoot,
        new Set(['@agimon-ai/doompi-extension-contracts', 'hono', ...resourceManifests.keys()]),
      );
      for (const [packageName, manifestPath] of resourceManifests) {
        copyInstalledPackage(manifestPath, path.join(runnerDirectory, 'node_modules', ...packageName.split('/')));
      }
      const contractsManifest = installedRequire.resolve('@agimon-ai/doompi-extension-contracts/package.json');
      copyInstalledPackage(
        contractsManifest,
        path.join(sourceRoot, 'node_modules', '@agimon-ai', 'doompi-extension-contracts'),
      );
      const honoManifest = path.join(path.dirname(runnerManifest), 'node_modules', 'hono', 'package.json');
      copyInstalledPackage(honoManifest, path.join(sourceRoot, 'node_modules', 'hono'));

      const entry = path.join(runnerDirectory, 'dist', 'extensions', 'server.mjs');
      const sourceBinary = path.join(
        runnerDirectory,
        'node_modules',
        ...resourcePackage.split('/'),
        'vendor',
        'bin',
        'rmux',
      );
      const sourceBinaryContents = fs.readFileSync(sourceBinary);
      const { descriptor } = await syncServerBundle({ ...input, compositions: [composition('coding', [entry])] });
      const generatedBinary = path.join(
        input.outputDirectory,
        'modules',
        '0',
        'node_modules',
        ...resourcePackage.split('/'),
        'vendor',
        'bin',
        'rmux',
      );
      expect(descriptor.entries).toHaveLength(1);
      expect(fs.readFileSync(generatedBinary)).toEqual(sourceBinaryContents);
      expect(fs.statSync(generatedBinary).mode & 0o777).toBe(fs.statSync(sourceBinary).mode & 0o777);
      const generatedTursoDirectory = path.join(
        input.outputDirectory,
        'modules',
        '0',
        'node_modules',
        ...tursoPlatformPackage.split('/'),
      );
      expect(fs.readdirSync(generatedTursoDirectory).some((name) => name.endsWith('.node'))).toBe(true);
      const generatedRunner = path.join(
        input.outputDirectory,
        'modules',
        '0',
        'node_modules',
        ...runnerPackage.split('/'),
      );
      expect(fs.existsSync(path.join(generatedRunner, 'dist', 'bin', 'runnerHost.mjs'))).toBe(true);
      expect(fs.existsSync(path.join(generatedRunner, 'dist', 'services', 'lifeline', 'client.mjs'))).toBe(true);
      expect(fs.existsSync(path.join(generatedRunner, 'dist', 'services', 'runnerSupervisor', 'index.mjs'))).toBe(true);

      fs.writeFileSync(sourceBinary, 'replacement');
      fs.rmSync(sourceRoot, { recursive: true, force: true });

      const generatedRequire = createRequire(path.join(generatedRunner, 'package.json'));
      const generatedTelemetryManifest = generatedRequire.resolve('@agimon-ai/doompi-telemetry/package.json');
      expect(fs.realpathSync(generatedTelemetryManifest)).toBe(
        fs.realpathSync(
          path.join(
            input.outputDirectory,
            'modules',
            '0',
            'node_modules',
            '@agimon-ai',
            'doompi-telemetry',
            'package.json',
          ),
        ),
      );
      expect(fs.realpathSync(generatedRequire.resolve('@opentelemetry/api'))).toBe(
        fs.realpathSync(
          path.join(
            input.outputDirectory,
            'modules',
            '0',
            'node_modules',
            '@opentelemetry',
            'api',
            'build',
            'src',
            'index.js',
          ),
        ),
      );
      const runnerHostPath = path.join(generatedRunner, 'dist', 'bin', 'runnerHost.mjs');
      const runnerSupervisorPath = path.join(generatedRunner, 'dist', 'services', 'runnerSupervisor', 'index.mjs');
      const runnerSupervisor = (await import(pathToFileURL(runnerSupervisorPath).href)) as {
        runtimeEntry(name: 'runnerHost', moduleUrl?: string): string;
      };
      const executable = runnerSupervisor.runtimeEntry('runnerHost', pathToFileURL(runnerSupervisorPath).href);
      expect(executable).toBe(fs.realpathSync(runnerHostPath));
      const spec = path.join(root, 'runner.command.json');
      const gate = path.join(root, 'runner.gate');
      const exit = path.join(root, 'runner.exit.json');
      const env = { HOME: root, PI_CODING_AGENT_DIR: path.join(root, 'agent') };
      fs.writeFileSync(spec, JSON.stringify({ command: 'printf runner-host-executed', cwd: root, env }));
      fs.writeFileSync(gate, '');
      expect(
        execFileSync(process.execPath, [executable, spec, gate, exit], { env, encoding: 'utf8', timeout: 5_000 }),
      ).toBe('runner-host-executed');
      expect(JSON.parse(fs.readFileSync(exit, 'utf8'))).toEqual({ code: 0, signal: null });
      const runnerHost = (await import(pathToFileURL(runnerHostPath).href)) as {
        main?: unknown;
      };
      expect(typeof runnerHost.main).toBe('function');
      const loaded = await loadServerBundle('session', loadOptions(input, 'coding', ['default']));
      expect(typeof loaded.facets[0]?.facet.apply).toBe('function');
      const capabilities = JSON.parse(
        execFileSync(generatedBinary, ['capabilities', '--json'], { encoding: 'utf8', timeout: 5_000 }),
      ) as { binary_contract_version?: number };
      expect(capabilities.binary_contract_version).toBe(1);
    },
  );
  it('does not publish a partial descriptor after compilation failure', async () => {
    const { root, input } = fixture();
    const good = installedPackage(root, 'a-good');
    const bad = installedPackage(root, 'z-bad');
    fs.writeFileSync(path.join(bad.directory, 'dist', 'server.mjs'), 'export default { broken syntax');
    await expect(
      syncServerBundle({ ...input, compositions: [composition('coding', [good.entry, bad.entry])] }),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(input.outputDirectory, DOOM_SERVER_BUNDLE_FILE))).toBe(false);
  });

  it('refuses to overwrite a completed generation', async () => {
    const { input } = fixture();
    await syncServerBundle(input);
    const file = path.join(input.outputDirectory, DOOM_SERVER_BUNDLE_FILE);
    const before = fs.readFileSync(file);
    await expect(syncServerBundle(input)).rejects.toThrow('cannot be overwritten');
    expect(fs.readFileSync(file)).toEqual(before);
  });
});
