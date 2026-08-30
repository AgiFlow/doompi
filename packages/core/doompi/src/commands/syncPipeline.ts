import os from 'node:os';
import path from 'node:path';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { ensureLayerPackages, type LayerPackageResult } from '../adapters/layerPackageInstaller.ts';
import { findRepositoryRoot } from '../adapters/repository/repository';
import type { HarnessTelemetry } from '../adapters/telemetry/logSinkTelemetry.ts';
import { acquireSyncLocationLock, resolveSyncLocation } from '../adapters/syncLocation.ts';
import { BuildCommand } from './buildCommand.ts';
import { SyncCommand, type SyncSettingsMode } from './syncCommand.ts';
import { SyncProgress, type SyncProgressOutput } from './syncPresenter.ts';

const CHECK_OPTION = '--check';
const HARNESS_ROOT_ENV = 'DOOMPI_ROOT';
const BUILD_COMMAND = 'build';
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
export class SyncPipeline {
  private readonly settingsMode: SyncSettingsMode;
  private readonly telemetry: HarnessTelemetry | undefined;

  constructor(options: SyncPipelineOptions = {}) {
    this.settingsMode = options.settingsMode ?? 'persisted';
    this.telemetry = options.telemetry;
  }

  async execute(
    args: string[],
    environment: NodeJS.ProcessEnv = process.env,
    currentDirectory = process.cwd(),
    output: SyncProgressOutput = process.stdout,
  ): Promise<number> {
    if (args.includes(CHECK_OPTION)) {
      return new SyncCommand({ settingsMode: this.settingsMode }).execute(args, environment, currentDirectory, output);
    }

    const inheritedRoot = environment[HARNESS_ROOT_ENV];
    const repoRoot = inheritedRoot ? path.resolve(inheritedRoot) : findRepositoryRoot(currentDirectory);
    const homeDirectory = environment.HOME ?? os.homedir();
    const releaseLock = await acquireSyncLocationLock(resolveSyncLocation(repoRoot, homeDirectory));
    try {
      const progress = new SyncProgress(output);
      await this.refreshPackages(environment, currentDirectory, progress);

      const captured: string[] = [];
      const done = progress.start(BUILD_LABEL, 'compiling the mode extension');
      const buildCode = await new BuildCommand(this.telemetry).execute(
        [BUILD_COMMAND, ...args.slice(1).filter((argument) => argument !== CHECK_OPTION)],
        environment,
        currentDirectory,
        {
          write: (chunk: unknown) => {
            captured.push(String(chunk));
            return true;
          },
        },
      );
      if (buildCode !== 0) {
        done('failed');
        output.write(captured.join(''));
        return buildCode;
      }
      done('mode extension compiled');

      return await new SyncCommand({
        settingsMode: this.settingsMode,
        homeDirectory,
        lockHeld: true,
      }).execute(args, environment, currentDirectory, output);
    } finally {
      await releaseLock();
    }
  }

  /** Moves every package sync owns to its newest published version. */
  private async refreshPackages(
    environment: NodeJS.ProcessEnv,
    currentDirectory: string,
    progress: SyncProgress,
  ): Promise<void> {
    const inheritedRoot = environment[HARNESS_ROOT_ENV];
    const repoRoot = inheritedRoot ? path.resolve(inheritedRoot) : findRepositoryRoot(currentDirectory);
    const config = loadMajorModesConfig(repoRoot);
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
}
