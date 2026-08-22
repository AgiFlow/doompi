import path from 'node:path';
import {
  createLayerResolvers,
  type ExtensionComposition,
  resolveExtensionComposition,
} from '../services/extensionAssembler.ts';
import type { HarnessOptions } from '../types/interfaces/harness';
import { writeFileAtomic } from './serialization/json';
import { compileExtensionSet, extensionSetManifestPath } from './extensionCompiler.ts';
import type { HarnessContext } from './harnessContext.ts';
import { resolveSyncLocation } from './syncLocation.ts';

const EXTENSION_CACHE_DIRECTORY = 'cache';
const MODE_DIST_DIRECTORY = 'dist';
const MODE_BUILD_MANIFEST_VERSION = 4;

export interface RuntimeExtensionPlan {
  /** Actual Pi factory activation order. */
  extensions: string[];
  /** Actual detached-child factory activation order. */
  childExtensions: string[];
  fingerprint: string;
  composition: ExtensionComposition;
}

export interface RuntimeBundleBuild extends RuntimeExtensionPlan {
  bundle: string;
  manifest: string;
}

export interface ModeBuildSelection {
  majorMode: string;
  domains: string[];
  profile?: string;
  preset: string;
  mute: boolean;
  autoStop: boolean;
  agents: boolean;
  mcp: boolean;
}

export interface ModeBuildManifest {
  version: number;
  artifact: string;
  compositionFingerprint: string;
  selection: ModeBuildSelection;
  /** Original source entries in the order their factories activate. */
  extensionPaths: string[];
  /** Original source entries inherited by detached child agents. */
  childExtensionPaths: string[];
  resources: {
    /** Exact SKILL.md paths; never derived from the bundled artifact path. */
    skillPaths: string[];
    pluginRoots: string[];
  };
}

export interface ModeExtensionBuildOptions {
  repoRoot: string;
  selection: ModeBuildSelection;
  extensionPaths: readonly string[];
  childExtensionPaths?: readonly string[];
  skillPaths?: readonly string[];
  pluginRoots?: readonly string[];
  /** Canonical identity returned by resolveExtensionComposition(). */
  compositionFingerprint: string;
  outputName?: string;
  cacheDirectory?: string;
  outputDirectory?: string;
  sharedCacheDirectory?: string;
}

/** Resolves the parent and detached-child extension lists for one launch. */
export function createRuntimeExtensionPlan(context: HarnessContext): RuntimeExtensionPlan {
  const common = {
    agents: context.options.agents,
    preset: context.options.preset,
    personaEntry: context.personaEntry,
    layers: context.selectedLayers,
    majorModesConfig: context.majorModesConfig,
    resolvers: createLayerResolvers(context.options.repoRoot),
  };
  const composition = resolveExtensionComposition({
    ...common,
    majorMode: context.options.majorMode,
    autoStop: context.options.autoStop,
    mute: context.options.mute,
  });
  return {
    extensions: [...composition.parentActivation],
    childExtensions: [...composition.childActivation],
    fingerprint: composition.fingerprint,
    composition,
  };
}

function modeSelection(options: HarnessOptions): ModeBuildSelection {
  return {
    majorMode: options.majorMode,
    domains: [...options.domains],
    profile: options.profile,
    preset: options.preset,
    mute: options.mute,
    autoStop: options.autoStop,
    agents: options.agents,
    mcp: options.mcp,
  };
}

function modeOutputName(selection: ModeBuildSelection): string {
  return [selection.majorMode, selection.mute ? 'mute' : undefined, selection.autoStop ? 'auto-stop' : undefined]
    .filter((value): value is string => Boolean(value))
    .join('.');
}

function manifestPathFor(bundle: string): string {
  return bundle.replace(/\.mjs$/, '.manifest.json');
}

/**
 * Emits one named mode extension and its original-path resource manifest.
 *
 * Extension code lives in dist while compiler fingerprints remain in cache.
 * Skill loading never follows the bundle's import.meta.url: Pi receives the
 * exact original SKILL.md paths recorded here and in harness state.
 */
export async function compileModeExtension(options: ModeExtensionBuildOptions): Promise<{
  bundle: string;
  manifest: string;
  compilerManifest: string;
}> {
  const extensionPaths = options.extensionPaths.map((entry) => path.resolve(entry));
  const selection = { ...options.selection, domains: [...options.selection.domains] };
  const location = resolveSyncLocation(options.repoRoot);
  const cacheDirectory = options.cacheDirectory ?? path.join(location.directory, EXTENSION_CACHE_DIRECTORY);
  const outputDirectory = options.outputDirectory ?? path.join(location.directory, MODE_DIST_DIRECTORY);
  const childExtensionPaths = (options.childExtensionPaths ?? []).map((entry) => path.resolve(entry));
  const resources = {
    skillPaths: (options.skillPaths ?? []).map((entry) => path.resolve(entry)),
    pluginRoots: (options.pluginRoots ?? []).map((entry) => path.resolve(entry)),
  };
  const outputBaseName = options.outputName ?? modeOutputName(selection);
  const outputName = `${outputBaseName}.${options.compositionFingerprint.slice(0, 12)}`;
  const bundle = await compileExtensionSet(extensionPaths, cacheDirectory, {
    outputDirectory,
    outputName,
    repositoryRoot: options.repoRoot,
    sharedCacheDirectory: options.sharedCacheDirectory ?? location.sharedCacheDirectory,
  });
  const compilerManifest = extensionSetManifestPath(extensionPaths, cacheDirectory, {
    outputDirectory,
    outputName,
  });
  const manifest = manifestPathFor(bundle);
  const contents: ModeBuildManifest = {
    version: MODE_BUILD_MANIFEST_VERSION,
    artifact: bundle,
    compositionFingerprint: options.compositionFingerprint,
    selection,
    extensionPaths,
    childExtensionPaths,
    resources,
  };
  writeFileAtomic(manifest, `${JSON.stringify(contents, null, 2)}\n`);
  return { bundle, manifest, compilerManifest };
}

/** Compiles the exact Pi load order used by the selected launch matrix. */
export async function buildRuntimeBundle(
  context: HarnessContext,
  plan: RuntimeExtensionPlan = createRuntimeExtensionPlan(context),
  location = resolveSyncLocation(context.options.repoRoot),
): Promise<RuntimeBundleBuild> {
  const built = await compileModeExtension({
    repoRoot: context.options.repoRoot,
    cacheDirectory: path.join(location.directory, EXTENSION_CACHE_DIRECTORY),
    outputDirectory: path.join(location.directory, MODE_DIST_DIRECTORY),
    sharedCacheDirectory: location.sharedCacheDirectory,
    selection: modeSelection(context.options),
    extensionPaths: plan.extensions,
    childExtensionPaths: plan.childExtensions,
    compositionFingerprint: plan.fingerprint,
    skillPaths: context.resources.skillDirectories,
    pluginRoots: context.plugins.map((plugin) => plugin.directory),
  });
  return { ...plan, ...built };
}
