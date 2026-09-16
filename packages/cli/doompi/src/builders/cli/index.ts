import os from 'node:os';
import path from 'node:path';

import { readHarnessState } from '@agimon-ai/doompi-config/harnessState';
import { filterHookDisabledLayers, loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { resolveSyncLocation } from '@agimon-ai/doompi-core/sync-location';
import { BUNDLED_PRECOMPILE_STRATEGY, PRECOMPILE_STATE_VERSION } from '@agimon-ai/doompi-core/sync-state-contract';

import { compileExtensionSet, extensionSetManifestPath } from '../../compiler';
import {
  createMapResolvers,
  readSyncState,
  type SyncState,
  syncDirectory,
  writeSyncState,
} from '../../composition/syncState';
import { ownEntry } from './entryResolution';
import { PERSONA_ENTRY, resolveExtensionComposition, type ExtensionComposition } from './extensionAssembler';
import { compileModeExtension, type ModeBuildSelection } from './runtimeBundle';

const EXTENSION_CACHE_DIRECTORY = 'cache';
const MODE_DIST_DIRECTORY = 'dist';
const COMPOSED_PI_ENTRY = 'composedPi';

export interface SyncedRuntimeBuild {
  bootstrap: string;
  bundles: Record<string, string>;
  bundleManifests: Record<string, string>;
  state: SyncState;
  compositions: ExtensionComposition[];
}

export interface SyncedRuntimeBuildOptions {
  /** In-memory state being staged into a not-yet-published generation. */
  state?: SyncState;
  /** Generation root for cache and compiled outputs. */
  directory?: string;
  /** Starts dependent target builds as soon as composition planning finishes. */
  onCompositionsResolved?: (compositions: readonly ExtensionComposition[]) => void;
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
  const majorModesConfig = loadMajorModesConfig(repoRoot, homeDirectory);
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
  const compositions: ExtensionComposition[] = [];
  const builds: {
    composition: ExtensionComposition;
    majorMode: string;
    mute: boolean;
    options: Parameters<typeof compileModeExtension>[0];
  }[] = [];
  for (const [majorMode, definition] of Object.entries(majorModesConfig.majorMode)) {
    const selectedLayers = filterHookDisabledLayers(majorModesConfig, definition.layers, harness.hooks);
    for (const mute of [false, true]) {
      const composition = resolveExtensionComposition({
        ...base,
        majorMode,
        layers: selectedLayers,
        mute,
      });
      compositions.push(composition);
      const extensionPaths = [...composition.parentActivation];
      const childExtensionPaths = [...composition.childActivation];
      const outputName = `${majorMode}${mute ? '.mute' : ''}`;
      builds.push({
        composition,
        majorMode,
        mute,
        options: {
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
        },
      });
    }
  }
  options.onCompositionsResolved?.(compositions);
  const results = await Promise.allSettled(builds.map(({ options }) => compileModeExtension(options)));
  for (const [index, result] of results.entries()) {
    const { composition, majorMode, mute } = builds[index]!;
    if (result.status === 'fulfilled') {
      bundles[composition.fingerprint] = result.value.bundle;
      bundleManifests[composition.fingerprint] = result.value.compilerManifest;
    } else {
      const detail = result.reason instanceof Error ? result.reason.message : String(result.reason);
      process.stderr.write(`[doompi] could not precompile ${majorMode}${mute ? ' (mute)' : ''}: ${detail}\n`);
    }
  }

  if (!bundles[state.compositionFingerprint]) {
    throw new Error('The synchronized active composition did not produce a bundle. Run doompi sync.');
  }

  const bootstrapEntries = [ownEntry(COMPOSED_PI_ENTRY)];
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
    compositions,
  };
}
