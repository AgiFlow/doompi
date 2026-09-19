import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  DOOM_MCP_BUNDLE_FILE,
  DOOM_MCP_BUNDLE_VERSION,
  type DoomMcpBundle,
  type DoomMcpBundleEntry,
  parseDoomMcpBundle,
} from '@agimon-ai/doompi-core/mcp-facet';
import { writeFileAtomic } from '@agimon-ai/doompi-core/runtime-json';
import type { DoomServerBundleOwner } from '@agimon-ai/doompi-core/server-facet';

import { compileExtensionModule, extensionModuleManifestPath } from '../../compiler';
import type { ExtensionComposition } from '../cli/extensionAssembler';

interface DeclaredMcpPlugin {
  readonly packageName: string;
  readonly packageDir: string;
  readonly entry: string;
  readonly dist: string;
}

export interface McpBundleSyncInput {
  readonly generation: string;
  readonly fingerprint: string;
  readonly repositoryRoot: string;
  readonly compositions: readonly ExtensionComposition[];
  readonly outputDirectory: string;
  readonly cacheDirectory: string;
  readonly sharedCacheDirectory?: string;
}

export interface McpBundleSyncResult {
  readonly descriptor: DoomMcpBundle;
  readonly compilerManifests: Record<string, string>;
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

function packagePath(packageDir: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('./') || value.includes('..'))
    throw new Error(`doompiMcp ${field} in ${packageDir} must be a package-relative ./path with no '..'.`);
  return value;
}

function declaredMcpPlugin(packageDir: string, manifest: Record<string, unknown>): DeclaredMcpPlugin | undefined {
  const value = manifest.doompiMcp;
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`doompiMcp manifest in ${packageDir} must be an object.`);
  const declaration = value as Record<string, unknown>;
  if (!Array.isArray(declaration.scopes) || declaration.scopes.length !== 1 || declaration.scopes[0] !== 'session')
    throw new Error(`doompiMcp scopes in ${packageDir} must be exactly ['session'].`);
  const packageName = manifest.name;
  if (typeof packageName !== 'string' || packageName === '') throw new Error(`Package in ${packageDir} has no name.`);
  return {
    packageName,
    packageDir,
    entry: packagePath(packageDir, 'entry', declaration.entry),
    dist: packagePath(packageDir, 'dist', declaration.dist),
  };
}

/** Stages explicit package MCP entries into a generation-owned descriptor. */
export async function syncMcpBundle(input: McpBundleSyncInput): Promise<McpBundleSyncResult> {
  const descriptorPath = path.join(input.outputDirectory, DOOM_MCP_BUNDLE_FILE);
  if (fs.existsSync(descriptorPath)) throw new Error('An MCP bundle generation cannot be overwritten');
  const packages = new Map<string, { declaration: DeclaredMcpPlugin; owners: DoomServerBundleOwner[] }>();
  for (const composition of input.compositions) {
    const majorMode = composition.majorMode?.name;
    if (!majorMode) throw new Error('An MCP bundle composition needs its major mode');
    for (const root of new Set(composition.parentActivation.map(packageRootOf))) {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
      const declaration = declaredMcpPlugin(root, manifest);
      if (declaration === undefined) continue;
      const previous = packages.get(declaration.packageName);
      if (previous && previous.declaration.packageDir !== root)
        throw new Error(`Ambiguous MCP bundle package: ${declaration.packageName}`);
      const candidate = previous ?? { declaration, owners: [] };
      const layers = composition.selections
        .filter(
          (selection) => selection.outcome === 'resolved' && selection.path && packageRootOf(selection.path) === root,
        )
        .map((selection) => selection.layer);
      for (const layer of new Set(layers.length > 0 ? layers : ['default'])) {
        if (!candidate.owners.some((owner) => owner.majorMode === majorMode && owner.layer === layer))
          candidate.owners.push({ majorMode, layer });
      }
      packages.set(declaration.packageName, candidate);
    }
  }
  fs.mkdirSync(input.outputDirectory, { recursive: true });
  const entries: DoomMcpBundleEntry[] = [];
  const compilerManifests: Record<string, string> = {};
  for (const [index, { declaration, owners }] of [...packages.values()].entries()) {
    const builtEntry = fs.realpathSync(path.resolve(declaration.packageDir, declaration.dist));
    const relative = path.relative(declaration.packageDir, builtEntry);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error(`MCP entry escapes package: ${declaration.packageName}`);
    const compileOptions = {
      repositoryRoot: input.repositoryRoot,
      sharedCacheDirectory: input.sharedCacheDirectory,
      outputDirectory: path.join(input.outputDirectory, 'modules', String(index)),
      outputName: 'plugin',
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
      sha256: crypto.createHash('sha256').update(fs.readFileSync(module)).digest('hex'),
      owners,
    });
  }
  const descriptor = parseDoomMcpBundle({
    version: DOOM_MCP_BUNDLE_VERSION,
    generation: input.generation,
    fingerprint: input.fingerprint,
    entries,
  });
  writeFileAtomic(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
  return { descriptor, compilerManifests };
}
