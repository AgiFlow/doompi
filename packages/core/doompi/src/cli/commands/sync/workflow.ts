import os from 'node:os';
import path from 'node:path';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { ensureLayerPackages, type LayerPackageResult } from '../../../composition/layerPackageInstaller';
import { resolveDoomConfigurationRoot } from '../../../composition/repository';
import type { HarnessTelemetry } from '@agimon-ai/doompi-core/runtime-log-sink-telemetry';
import { acquireSyncLocationLock, resolveSyncLocation } from '@agimon-ai/doompi-core/sync-location';
import { readSyncDrift } from '../../../composition/syncDrift';
import { prepareSync } from './prepare';
import { synchronize, type SyncSettingsMode } from './index';
import { SyncProgress, type SyncProgressOutput } from './presenter';
import { syncHelp } from './help';
import { wantsHelp } from '../../router';

const CHECK_OPTION = '--check';
/** Rebuilds and republishes even when nothing drifted. */
const FORCE_OPTION = '--force';
const HARNESS_ROOT_ENV = 'DOOMPI_ROOT';
const PACKAGES_LABEL = 'packages';
const BUILD_LABEL = 'build';

export interface SyncPipelineOptions {
  settingsMode?: SyncSettingsMode;
  telemetry?: HarnessTelemetry;
}

function pluralize(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function packageSummary(result: LayerPackageResult): string {
  const parts: string[] = [];
  if (result.updated.length > 0) parts.push(`updated ${pluralize(result.updated.length, 'package')}`);
  if (result.installed.length > 0) parts.push(`installed ${pluralize(result.installed.length, 'missing package')}`);
  if (parts.length === 0) parts.push('already up to date');
  if (result.unchecked.length > 0) parts.push(`${pluralize(result.unchecked.length, 'package')} left unchecked`);
  return parts.join(', ');
}

/** Refreshes packages, runs the private cache build, then commits the synchronized state. */
export async function runSync(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  currentDirectory = process.cwd(),
  output: SyncProgressOutput = process.stdout,
  options: SyncPipelineOptions = {},
): Promise<number> {
  // Before the --check split, so both `sync --help` and `sync --check --help`
  // print instead of running a sync nobody asked for.
  if (wantsHelp(args)) {
    output.write(syncHelp());
    return 0;
  }
  if (args.includes(CHECK_OPTION)) {
    return synchronize(args, environment, currentDirectory, output, {
      settingsMode: options.settingsMode ?? 'persisted',
    });
  }

  const homeDirectory = environment.HOME ?? os.homedir();
  const inheritedRoot = environment[HARNESS_ROOT_ENV];
  const repoRoot = inheritedRoot
    ? path.resolve(inheritedRoot)
    : resolveDoomConfigurationRoot(currentDirectory, homeDirectory);

  // Nothing drifted means the packages are current, the mode extension is
  // compiled from these exact bytes, and the published generation already
  // describes them. Refreshing and rebuilding anyway costs seconds per call
  // and, worse, ends in a republished generation that reloads every attached
  // cockpit for no change at all. The cockpit calls this before every session
  // launch, so the cheap answer has to be the common one.
  const driftOptions = {
    repoRoot,
    homeDirectory,
    requireWebBundle: Boolean(environment.DOOMPI_WEB_PACKAGE_ROOT),
  };
  if (!args.includes(FORCE_OPTION) && readSyncDrift(driftOptions).fresh) {
    output.write('doompi sync is already up to date\n');
    return 0;
  }

  const releaseLock = await acquireSyncLocationLock(resolveSyncLocation(repoRoot, homeDirectory));
  try {
    // A concurrent publisher may have resolved the drift while this command
    // waited for the lock. Do not rebuild and republish the same generation.
    if (!args.includes(FORCE_OPTION) && readSyncDrift(driftOptions).fresh) {
      output.write('doompi sync is already up to date\n');
      return 0;
    }
    const progress = new SyncProgress(output);
    await refreshPackages(environment, currentDirectory, progress);

    const captured: string[] = [];
    const done = progress.start(BUILD_LABEL, 'compiling the mode extension');
    const buildCode = await prepareSync(
      args,
      environment,
      currentDirectory,
      {
        write: (chunk: unknown) => {
          captured.push(String(chunk));
          return true;
        },
      },
      options.telemetry,
    );
    if (buildCode !== 0) {
      done('failed');
      output.write(captured.join(''));
      return buildCode;
    }
    done('mode extension compiled');

    return await synchronize(args, environment, currentDirectory, output, {
      settingsMode: options.settingsMode ?? 'persisted',
      homeDirectory,
      lockHeld: true,
    });
  } finally {
    await releaseLock();
  }
}
/** Moves every package sync owns to its newest published version. */
async function refreshPackages(
  environment: NodeJS.ProcessEnv,
  currentDirectory: string,
  progress: SyncProgress,
): Promise<void> {
  const homeDirectory = environment.HOME ?? os.homedir();
  const inheritedRoot = environment[HARNESS_ROOT_ENV];
  const repoRoot = inheritedRoot
    ? path.resolve(inheritedRoot)
    : resolveDoomConfigurationRoot(currentDirectory, homeDirectory);
  const config = loadMajorModesConfig(repoRoot, homeDirectory);
  const done = progress.start(PACKAGES_LABEL, 'checking configured packages for updates');
  const result = await ensureLayerPackages({
    repoRoot,
    config,
    // Every declared layer, not only the selected one: sync writes the state a
    // later /mode switch reads without reinstalling.
    layers: Object.keys(config.layers),
    environment,
    refresh: true,
    onProgress: (message) => progress.line(PACKAGES_LABEL, message),
  });
  done(packageSummary(result));
}
