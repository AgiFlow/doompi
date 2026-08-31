import os from 'node:os';
import path from 'node:path';
import { readHarnessState } from '@agimon-ai/doompi-config/harnessState';
import { filterHookDisabledLayers, loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { PERSONA_ENTRY, resolveExtensionComposition } from '../services/extensionAssembler.ts';
import { compileExtensionSet, extensionSetManifestPath } from './extensionCompiler.ts';
import { ownEntry } from './modules/moduleResolution.ts';
import { compileModeExtension, type ModeBuildSelection } from './runtimeBundle.ts';
import { resolveSyncLocation } from './syncLocation.ts';
import { createMapResolvers, readSyncState, type SyncState, syncDirectory, writeSyncState } from './syncState.ts';
import { BUNDLED_PRECOMPILE_STRATEGY, PRECOMPILE_STATE_VERSION } from './syncStateContract.ts';

const EXTENSION_CACHE_DIRECTORY = 'cache';
const MODE_DIST_DIRECTORY = 'dist';
const DOOM_ENTRY = 'doom';

export interface SyncedRuntimeBuild {
  bootstrap: string;
  bundles: Record<string, string>;
  bundleManifests: Record<string, string>;
  state: SyncState;
}

export interface SyncedRuntimeBuildOptions {
  /** In-memory state being staged into a not-yet-published generation. */
  state?: SyncState;
  /** Generation root for cache and compiled outputs. */
  directory?: string;
}

function mergedEnvironment(recorded: Record<string, string>, current: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...recorded };
  for (const [key, value] of Object.entries(current)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function selectionFor(
  state: SyncState,
  harness: ReturnType<typeof readHarnessState>,
  majorMode: string,
  mute: boolean,
): ModeBuildSelection {
  return {
    majorMode,
    domains: [...state.selection.domains],
    profile: state.selection.profile,
    preset: state.selection.preset,
    mute,
    autoStop: false,
    agents: harness.agents,
    mcp: harness.mcp,
  };
}

function compilationStateChanged(previous: SyncState, current: SyncState): boolean {
  return (
    previous.inputsHash !== current.inputsHash ||
    JSON.stringify(previous.selection) !== JSON.stringify(current.selection) ||
    JSON.stringify(previous.resolved) !== JSON.stringify(current.resolved)
  );
}

/** Heavy graph bundling reserved for the private build phase of `doompi sync`. */
export async function buildSyncedRuntime(
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = environment.HOME ?? os.homedir(),
  options: SyncedRuntimeBuildOptions = {},
): Promise<SyncedRuntimeBuild> {
  const state = options.state ?? readSyncState(repoRoot, homeDirectory);
  if (!state) throw new Error(`DoomPi is not synchronized at ${repoRoot}. Run doompi sync.`);

  const runtimeEnvironment = mergedEnvironment(state.env, environment);
  const harness = readHarnessState(runtimeEnvironment);
  const majorModesConfig = loadMajorModesConfig(repoRoot);
  const resolvers = createMapResolvers(state.resolved);
  const base = {
    agents: harness.agents,
    autoStop: false,
    preset: state.selection.preset,
    personaEntry: resolvers.packageEntry(PERSONA_ENTRY),
    majorModesConfig,
    resolvers,
  };

  const location = resolveSyncLocation(repoRoot, homeDirectory);
  const directory = options.directory ?? syncDirectory(repoRoot, homeDirectory);
  const cacheDirectory = path.join(directory, EXTENSION_CACHE_DIRECTORY);
  const outputDirectory = path.join(directory, MODE_DIST_DIRECTORY);
  const bundles: Record<string, string> = {};
  const bundleManifests: Record<string, string> = {};

  for (const [majorMode, definition] of Object.entries(majorModesConfig.majorMode)) {
    const selectedLayers = filterHookDisabledLayers(majorModesConfig, definition.layers, harness.hooks);
    for (const mute of [false, true]) {
      const composition = resolveExtensionComposition({
        ...base,
        majorMode,
        layers: selectedLayers,
        mute,
      });
      const extensionPaths = [...composition.parentActivation];
      const childExtensionPaths = [...composition.childActivation];
      const outputName = `${majorMode}${mute ? '.mute' : ''}`;
      try {
        const built = await compileModeExtension({
          repoRoot,
          selection: selectionFor(state, harness, majorMode, mute),
          extensionPaths,
          childExtensionPaths,
          compositionFingerprint: composition.fingerprint,
          skillPaths: harness.skillDirectories,
          pluginRoots: harness.pluginDirectories,
          outputName,
          cacheDirectory,
          outputDirectory,
          sharedCacheDirectory: location.sharedCacheDirectory,
        });
        bundles[composition.fingerprint] = built.bundle;
        bundleManifests[composition.fingerprint] = built.compilerManifest;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[doompi] could not precompile ${majorMode}${mute ? ' (mute)' : ''}: ${detail}\n`);
      }
    }
  }

  if (!bundles[state.compositionFingerprint]) {
    throw new Error('The synchronized active composition did not produce a bundle. Run doompi sync.');
  }

  const bootstrapEntries = [ownEntry(DOOM_ENTRY)];
  const bootstrapOptions = { outputDirectory, outputName: 'bootstrap' };
  const bootstrap = await compileExtensionSet(bootstrapEntries, cacheDirectory, {
    ...bootstrapOptions,
    repositoryRoot: repoRoot,
    sharedCacheDirectory: location.sharedCacheDirectory,
  });
  const bootstrapManifest = extensionSetManifestPath(bootstrapEntries, cacheDirectory, bootstrapOptions);

  const nextState: SyncState = {
    ...state,
    compiled: undefined,
    bundles,
    bootstrap,
    precompile: {
      version: PRECOMPILE_STATE_VERSION,
      strategy: BUNDLED_PRECOMPILE_STRATEGY,
      bootstrapEntry: bootstrapEntries[0],
      bootstrapManifest,
      bundleManifests,
    },
  };
  if (options.state === undefined) {
    const current = readSyncState(repoRoot, homeDirectory);
    if (!current) throw new Error(`DoomPi synchronization disappeared while compiling ${repoRoot}`);
    if (compilationStateChanged(state, current)) {
      throw new Error(`DoomPi synchronization changed while compiling ${repoRoot}; restart Pi to use the new state.`);
    }
    await writeSyncState(repoRoot, nextState, homeDirectory);
  }
  return {
    bootstrap,
    bundles,
    bundleManifests,
    state: nextState,
  };
}
