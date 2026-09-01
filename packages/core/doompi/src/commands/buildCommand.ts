import os from 'node:os';
import path from 'node:path';
import type { MajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { buildHarnessContext } from '../adapters/harnessContext.ts';
import { ensureLayerPackages } from '../adapters/layerPackageInstaller.ts';
import { DUPLICATE_REGISTRATION_DRIFT, projectRegistersDoom } from '../adapters/projectPiSettings.ts';
import { buildRuntimeBundle } from '../adapters/runtimeBundle.ts';
import type { SyncedRuntimeBuild } from '../adapters/syncedRuntimeBuilder.ts';
import { resolveSyncLocation } from '../adapters/syncLocation.ts';
import {
  computeInputsHash,
  readSyncState,
  recordResolvedEntries,
  type SyncState,
  syncStateRootMatches,
} from '../adapters/syncState.ts';
import type { HarnessTelemetry } from '../adapters/telemetry/logSinkTelemetry.ts';
import { loadDomains } from '@agimon-ai/doompi-config/domains';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { createLayerResolvers } from '../services/extensionAssembler.ts';
import { resolveDoomConfigurationRoot } from '../adapters/repository/repository';
import { parseHarnessArgs } from './cli/options.ts';
import { selectionEnvironment } from './syncCommand.ts';

const BUILD_COMMAND = 'build';
const HARNESS_ROOT_ENV = 'DOOMPI_ROOT';

type BuildOutput = Pick<NodeJS.WritableStream, 'write'>;

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

export function formatBuildResult(result: BuildResult): string {
  return [
    `bundle:     ${result.bundle}`,
    `manifest:   ${result.manifest}`,
    `extensions: ${result.extensionCount} -> 1`,
    `skills:     ${result.skillCount}`,
    `agents:     ${result.agentCount}`,
    ...(result.syncedBootstrap
      ? [`bootstrap:  ${result.syncedBootstrap}`, `modes:      ${String(result.syncedBundleCount ?? 0)} precompiled`]
      : []),
    // Build never writes settings, so it reports what only sync can repair.
    ...(result.duplicateRegistration ? [`warning:    ${DUPLICATE_REGISTRATION_DRIFT}; run doompi sync`] : []),
    '',
    'Doom Pi is built. The next launch will use the dist mode extension.',
    '',
  ].join('\n');
}

/** Builds the selected mode extension without launching Pi or changing settings. */
export class BuildCommand {
  readonly name = BUILD_COMMAND;
  private readonly telemetry: HarnessTelemetry | undefined;

  constructor(telemetry?: HarnessTelemetry) {
    this.telemetry = telemetry;
  }

  matches(args: string[]): boolean {
    return args[0] === this.name;
  }

  async execute(
    args: string[],
    environment: NodeJS.ProcessEnv = process.env,
    currentDirectory = process.cwd(),
    output: BuildOutput = process.stdout,
  ): Promise<number> {
    const homeDirectory = environment.HOME ?? os.homedir();
    const inheritedRoot = environment[HARNESS_ROOT_ENV];
    const repoRoot = inheritedRoot
      ? path.resolve(inheritedRoot)
      : resolveDoomConfigurationRoot(currentDirectory, homeDirectory);
    const location = resolveSyncLocation(repoRoot, homeDirectory);
    const parsed = parseHarnessArgs(
      args.slice(1),
      selectionEnvironment(repoRoot, environment),
      currentDirectory,
      loadMajorModesConfig(repoRoot, homeDirectory).defaultMajorMode,
      loadDomains(repoRoot, homeDirectory).defaultDomains,
    );
    const context = await buildHarnessContext({ ...parsed.options, repoRoot, homeDirectory }, this.telemetry);
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
        const { buildSyncedRuntime } = await import('../adapters/syncedRuntimeBuilder.ts');
        synced = await buildSyncedRuntime(repoRoot, environment, homeDirectory);
      }
      output.write(
        formatBuildResult({
          bundle: built.bundle,
          manifest: built.manifest,
          extensionCount: built.extensions.length,
          skillCount: context.resources.skillCount,
          agentCount: context.resources.agentCount,
          syncedBootstrap: synced?.bootstrap,
          syncedBundleCount: synced ? Object.keys(synced.bundles).length : undefined,
          duplicateRegistration: projectRegistersDoom(repoRoot),
        }),
      );
      return 0;
    } finally {
      await context.cleanup();
    }
  }
}
