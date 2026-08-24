import path from 'node:path';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { ensureLayerPackages, type LayerPackageResult } from '../adapters/layerPackageInstaller.ts';
import { findRepositoryRoot } from '../adapters/repository/repository';
import type { HarnessTelemetry } from '../adapters/telemetry/logSinkTelemetry.ts';
import { readLocatedSyncState } from '../adapters/syncState.ts';
import { syncWebBundle } from '../adapters/webBundleSync.ts';
import { BuildCommand } from './buildCommand.ts';
import { SyncCommand, type SyncSettingsMode } from './syncCommand.ts';
import { SyncProgress, type SyncProgressOutput } from './syncPresenter.ts';

const CHECK_OPTION = '--check';
const HARNESS_ROOT_ENV = 'DOOMPI_ROOT';
const BUILD_COMMAND = 'build';
const PACKAGES_LABEL = 'packages';
const BUILD_LABEL = 'build';
const WEB_LABEL = 'web';

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

    const progress = new SyncProgress(output);
    // Packages move before anything reads them: the build compiles the resolved
    // extension files and the sync stages their skills, agents, and MCP servers,
    // so an update landing after either phase would only take effect one sync later.
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
      // The build phase stays quiet while it succeeds. A failure is the one case
      // where its own report is the only explanation the user has.
      output.write(captured.join(''));
      return buildCode;
    }
    done('mode extension compiled');

    const syncCode = await new SyncCommand({ settingsMode: this.settingsMode }).execute(
      args,
      environment,
      currentDirectory,
      output,
    );
    if (syncCode !== 0) return syncCode;

    // The cockpit bundle rides the committed state: the resolved composition
    // names every installed package whose doompiWeb manifest contributes a
    // web plugin. A bundle failure never fails the sync; the cockpit keeps
    // serving its previous or packaged bundle.
    await this.refreshWebBundle(environment, currentDirectory, progress);
    return 0;
  }

  /** Rebuilds the machine's cockpit bundle from the synced composition's plugin manifests. */
  private async refreshWebBundle(
    environment: NodeJS.ProcessEnv,
    currentDirectory: string,
    progress: SyncProgress,
  ): Promise<void> {
    const inheritedRoot = environment[HARNESS_ROOT_ENV];
    const repoRoot = inheritedRoot ? path.resolve(inheritedRoot) : findRepositoryRoot(currentDirectory);
    const done = progress.start(WEB_LABEL, 'bundling the web cockpit plugins');
    const state = readLocatedSyncState(repoRoot);
    if (!state) {
      done('skipped: no sync state to read the composition from');
      return;
    }
    const result = await syncWebBundle({
      repoRoot,
      resolvedEntries: state.state.resolved,
      environment,
    });
    if (result.status === 'bundled') done(`cockpit bundled with plugins: ${result.pluginIds.join(', ')}`);
    else done(`${result.status}: ${result.reason}`);
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
