import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { writeFileAtomic } from '@agimon-ai/doompi-core/runtime-json';
import {
  DOOM_SERVER_BUNDLE_FILE,
  DOOM_SERVER_BUNDLE_VERSION,
  type DeclaredServerFacet,
  type DoomServerBundle,
  type DoomServerBundleEntry,
  type DoomServerBundleOwner,
  declaredServerFacetsOf,
  orderServerFacets,
  parseDoomServerBundle,
} from '@agimon-ai/doompi-core/server-facet';

import {
  compileExtensionModule,
  extensionModuleManifestPath,
  type CompileExtensionResourceBinding,
  type CompileExtensionResourcePackage,
} from '../../compiler';
import { compileApiContracts } from '../apiContracts';
import type { ExtensionComposition } from '../cli/extensionAssembler';

export interface ServerBundleSyncInput {
  readonly generation: string;
  readonly fingerprint: string;
  readonly repositoryRoot: string;
  readonly compositions: readonly ExtensionComposition[];
  /** Unpublished generation directory, protected by the caller's sync lock. */
  readonly outputDirectory: string;
  readonly cacheDirectory: string;
  readonly sharedCacheDirectory?: string;
}

export interface ServerBundleSyncResult {
  readonly descriptor: DoomServerBundle;
  readonly compilerManifests: Record<string, string>;
  readonly contractGaps: readonly string[];
}

function packageRootOf(entry: string): string {
  let directory = path.dirname(fs.realpathSync(entry));
  for (;;) {
    if (fs.existsSync(path.join(directory, 'package.json'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`No package manifest owns ${entry}`);
    directory = parent;
  }
}
function packageFiles(packageDirectory: string, extensions: readonly string[]): { path: string }[] {
  const files: { path: string }[] = [{ path: 'package.json' }];
  const collect = (directory: string, relativeDirectory: string): void => {
    for (const name of fs.readdirSync(directory)) {
      const source = path.join(directory, name);
      const relative = `${relativeDirectory}/${name}`;
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink()) throw new Error(`Runtime resource contains a symlink: ${relative}`);
      if (stat.isDirectory()) collect(source, relative);
      else if (extensions.some((extension) => name.endsWith(extension))) files.push({ path: relative });
    }
  };
  for (const directoryName of ['dist', 'build']) {
    const directory = path.join(packageDirectory, directoryName);
    if (fs.existsSync(directory)) collect(directory, directoryName);
  }
  return files;
}

function packageRuntimeFiles(packageDirectory: string): { path: string }[] {
  return packageFiles(packageDirectory, ['.mjs']);
}

/** Packages whose executable must survive independently of the installed source graph. */
function resourceBindingFor(
  declaration: DeclaredServerFacet,
  manifest: Record<string, unknown>,
): CompileExtensionResourceBinding | undefined {
  const optional = manifest.optionalDependencies;
  if (optional === null || typeof optional !== 'object' || Array.isArray(optional)) return undefined;
  const currentPlatformPackage = `@agimon-ai/doompi-runner-rmux-${process.platform}-${process.arch}`;
  const require = createRequire(path.join(declaration.packageDir, 'package.json'));
  for (const packageName of Object.keys(optional)) {
    if (packageName !== currentPlatformPackage) continue;
    let packageManifest: string;
    try {
      packageManifest = require.resolve(`${packageName}/package.json`);
    } catch {
      continue;
    }
    const packageDirectory = path.dirname(fs.realpathSync(packageManifest));
    if (!fs.existsSync(path.join(packageDirectory, 'vendor', 'bin', 'rmux'))) continue;
    const owner: CompileExtensionResourcePackage = {
      packageName: declaration.packageName,
      packageDirectory: declaration.packageDir,
      files: packageRuntimeFiles(declaration.packageDir),
    };
    const platform: CompileExtensionResourcePackage = {
      packageName,
      packageDirectory,
      files: ['package.json', 'vendor/bin/rmux', 'vendor/bin/rmux-daemon', 'vendor/libexec/rmux/rmux']
        .filter((file) => fs.existsSync(path.join(packageDirectory, file)))
        .map((file) => ({ path: file })),
    };
    const packages = [owner];
    const dependencies = manifest.dependencies;
    if (dependencies && typeof dependencies === 'object' && '@agimon-ai/doompi-telemetry' in dependencies) {
      // runnerHost imports telemetry at runtime. Declared dependencies are required,
      // so missing packages must fail staging rather than publish an incomplete graph.
      const telemetryManifest = require.resolve('@agimon-ai/doompi-telemetry/package.json');
      const telemetryDirectory = path.dirname(fs.realpathSync(telemetryManifest));
      packages.push({
        packageName: '@agimon-ai/doompi-telemetry',
        packageDirectory: telemetryDirectory,
        files: packageRuntimeFiles(telemetryDirectory),
      });
      const telemetryRequire = createRequire(telemetryManifest);
      const apiEntry = telemetryRequire.resolve('@opentelemetry/api');
      const apiDirectory = packageRootOf(apiEntry);
      packages.push({
        packageName: '@opentelemetry/api',
        packageDirectory: apiDirectory,
        files: packageFiles(apiDirectory, ['.js']),
      });
    }
    packages.push(platform);
    return {
      ownerPackageName: declaration.packageName,
      ownerDirectory: declaration.packageDir,
      packages,
    };
  }
  return undefined;
}

/** Stage one descriptor. The caller publishes the containing generation only after all gates pass. */
export async function syncServerBundle(input: ServerBundleSyncInput): Promise<ServerBundleSyncResult> {
  const descriptorPath = path.join(input.outputDirectory, DOOM_SERVER_BUNDLE_FILE);
  if (fs.existsSync(descriptorPath)) throw new Error('A server bundle generation cannot be overwritten');
  const descriptor = parseDoomServerBundle({
    version: DOOM_SERVER_BUNDLE_VERSION,
    generation: input.generation,
    fingerprint: input.fingerprint,
    entries: [],
  });
  const packages = new Map<string, { declaration: DeclaredServerFacet; owners: DoomServerBundleOwner[] }>();
  for (const composition of input.compositions) {
    const majorMode = composition.majorMode?.name;
    if (!majorMode) throw new Error('A server bundle composition needs its major mode');
    const roots = new Set(composition.parentActivation.map(packageRootOf));
    for (const root of roots) {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
      for (const declaration of declaredServerFacetsOf(root, manifest)) {
        const previous = packages.get(declaration.packageName);
        if (previous && previous.declaration.packageDir !== root) {
          throw new Error(`Ambiguous server bundle package: ${declaration.packageName}`);
        }
        const candidate = previous ?? { declaration, owners: [] };
        const layers = composition.selections
          .filter(
            (selection) => selection.outcome === 'resolved' && selection.path && packageRootOf(selection.path) === root,
          )
          .map((selection) => selection.layer);
        // Fixed host packages have no layer selection; default is always explicitly admitted.
        for (const layer of new Set(layers.length > 0 ? layers : ['default'])) {
          if (!candidate.owners.some((owner) => owner.majorMode === majorMode && owner.layer === layer)) {
            candidate.owners.push({ majorMode, layer });
          }
        }
        packages.set(declaration.packageName, candidate);
      }
    }
  }
  const ordered = orderServerFacets([...packages.values()].map(({ declaration }) => declaration));
  const entries: DoomServerBundleEntry[] = [];
  const compilerManifests: Record<string, string> = {};
  for (const [index, declaration] of ordered.entries()) {
    const builtEntry = fs.realpathSync(path.resolve(declaration.packageDir, declaration.dist));
    const relative = path.relative(declaration.packageDir, builtEntry);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Server entry escapes package: ${declaration.packageName}`);
    }
    const packageManifest = JSON.parse(
      fs.readFileSync(path.join(declaration.packageDir, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    const resources = resourceBindingFor(declaration, packageManifest);
    const compileOptions = {
      repositoryRoot: input.repositoryRoot,
      sharedCacheDirectory: input.sharedCacheDirectory,
      ...(resources ? { resources: [resources] } : {}),
      outputDirectory: path.join(input.outputDirectory, 'modules', String(index)),
      outputName: 'facet',
    };
    const module = await compileExtensionModule(builtEntry, input.cacheDirectory, compileOptions);
    compilerManifests[declaration.packageName] = extensionModuleManifestPath(
      builtEntry,
      input.cacheDirectory,
      compileOptions,
    );
    entries.push({
      packageName: declaration.packageName,
      entry: declaration.entry,
      module: `./${path.relative(input.outputDirectory, module).split(path.sep).join('/')}`,
      scopes: declaration.scopes,
      owners: packages.get(declaration.packageName)!.owners,
      required: declaration.required === true,
    });
  }
  const contracts = await compileApiContracts({
    descriptor: { ...descriptor, entries },
    packageRoots: new Map([...packages].map(([name, value]) => [name, value.declaration.packageDir])),
    repositoryRoot: input.repositoryRoot,
    outputDirectory: input.outputDirectory,
    cacheDirectory: input.cacheDirectory,
    sharedCacheDirectory: input.sharedCacheDirectory,
  });
  Object.assign(compilerManifests, contracts.compilerManifests);
  const complete = parseDoomServerBundle({ ...descriptor, entries, contracts: contracts.contracts });
  writeFileAtomic(descriptorPath, `${JSON.stringify(complete, null, 2)}\n`);
  return { descriptor: complete, compilerManifests, contractGaps: contracts.gaps };
}
