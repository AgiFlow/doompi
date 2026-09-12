import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { buildHarnessContext } from './harnessContext';
import { ensureLayerPackages } from '../../composition/layerPackageInstaller';
import { projectRegistersDoom } from './projectSettings';
import { buildRuntimeBundle } from './runtimeBundle';
import type { SyncedRuntimeBuild } from './index';
import { resolveSyncLocation } from '@agimon-ai/doompi-core/sync-location';
import {
  computeInputsHash,
  readSyncState,
  recordResolvedEntries,
  type SyncState,
  syncStateRootMatches,
} from '../../composition/syncState';
import type { HarnessTelemetry } from '@agimon-ai/doompi-core/runtime-log-sink-telemetry';
import { createLayerResolvers } from './extensionAssembler';

import os from 'node:os';
import type { HarnessOptions } from '../../composition/types/harness';
export interface BuildResult {
  bundle: string;
  manifest: string;
  extensionCount: number;
  skillCount: number;
  agentCount: number;
  syncedBootstrap?: string;
  syncedBundleCount?: number;
  /** Set when the repository registers DoomPi the user scope already provides. */
  duplicateRegistration?: boolean;
}

function syncStateIsCurrent(
  repoRoot: string,
  state: SyncState,
  majorModesConfig: MajorModesConfig,
  compositionFingerprint: string,
  homeDirectory: string,
): boolean {
  if (!syncStateRootMatches(repoRoot, state.root)) return false;
  if (state.compositionFingerprint !== compositionFingerprint) return false;
  if (computeInputsHash(repoRoot, state.selection, homeDirectory) !== state.inputsHash) return false;
  const resolved = recordResolvedEntries(majorModesConfig, createLayerResolvers(repoRoot));
  return JSON.stringify(resolved) === JSON.stringify(state.resolved);
}

export async function buildPreparedRuntime(
  options: HarnessOptions,
  environment: NodeJS.ProcessEnv,
  telemetry?: HarnessTelemetry,
): Promise<BuildResult> {
  const { repoRoot } = options;
  const homeDirectory = options.homeDirectory ?? environment.HOME ?? os.homedir();
  const location = resolveSyncLocation(repoRoot, homeDirectory);
  const context = await buildHarnessContext({ ...options, repoRoot, homeDirectory }, telemetry);
  try {
    await ensureLayerPackages({
      repoRoot,
      config: context.majorModesConfig,
      layers: context.selectedLayers,
      environment,
    });
    const built = await buildRuntimeBundle(context, undefined, location);
    let synced: SyncedRuntimeBuild | undefined;
    let syncState: ReturnType<typeof readSyncState>;
    try {
      syncState = readSyncState(repoRoot, homeDirectory);
    } catch {
      // The private build phase runs before `doompi sync` replaces stale state.
      // An obsolete state must not prevent that repair path from completing.
      syncState = undefined;
    }
    if (
      syncState &&
      syncStateIsCurrent(repoRoot, syncState, context.majorModesConfig, built.fingerprint, homeDirectory)
    ) {
      const { buildSyncedRuntime } = await import('./index');
      synced = await buildSyncedRuntime(repoRoot, environment, homeDirectory);
    }
    return {
      bundle: built.bundle,
      manifest: built.manifest,
      extensionCount: built.extensions.length,
      skillCount: context.resources.skillCount,
      agentCount: context.resources.agentCount,
      syncedBootstrap: synced?.bootstrap,
      syncedBundleCount: synced ? Object.keys(synced.bundles).length : undefined,
      duplicateRegistration: projectRegistersDoom(repoRoot),
    };
  } finally {
    await context.cleanup();
  }
}
