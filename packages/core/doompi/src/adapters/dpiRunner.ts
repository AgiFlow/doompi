import path from 'node:path';
import { initializeRepositoryDoomConfig, type RepositoryDoomInitResult } from '@agimon-ai/doompi-config';
import { installDpiSettingsOverlay, loadPiSettingsRuntime, type PiSettingsRuntime } from './dpiSettings.ts';

const INIT_COMMAND = 'init';
const SYNC_COMMAND = 'sync';
const FORCE_FLAG = '--force';
const PI_SUBAGENT_BINARY_ENV = 'PI_SUBAGENT_PI_BINARY';
const DPI_ENTRY_PATTERN = /^dpi(?:\.[cm]?js|\.ts)?$/u;

type PiModule = typeof import('@earendil-works/pi-coding-agent');

export interface DpiRunnerDependencies {
  init(args: string[]): number | Promise<number>;
  launchPi(args: string[]): Promise<number>;
  sync(args: string[]): Promise<number>;
}

async function loadPiModule(settingsRuntime: PiSettingsRuntime): Promise<PiModule> {
  const loaded = await import('@earendil-works/pi-coding-agent');
  if (loaded.SettingsManager !== settingsRuntime.SettingsManager) {
    throw new Error('DPI resolved more than one Pi settings runtime');
  }
  return loaded;
}

/** Marks the process as Pi and keeps any CLI-based nested fallback on DPI. */
export function configureDpiEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  entryPoint: string | undefined = process.argv[1],
): void {
  environment.PI_CODING_AGENT = 'true';
  environment.AI_AGENT = 'pi';
  if (!environment[PI_SUBAGENT_BINARY_ENV]?.trim() && entryPoint && DPI_ENTRY_PATTERN.test(path.basename(entryPoint))) {
    environment[PI_SUBAGENT_BINARY_ENV] = path.resolve(entryPoint);
  }
}

/** Runs the pinned upstream Pi entry point after installing DPI's settings view. */
export async function launchDpiPi(args: string[]): Promise<number> {
  const settingsRuntime = await loadPiSettingsRuntime();
  const pi = await loadPiModule(settingsRuntime);
  const restoreSettings = installDpiSettingsOverlay(settingsRuntime);
  process.title = 'dpi';
  configureDpiEnvironment();
  process.emitWarning = (() => undefined) as typeof process.emitWarning;

  try {
    await pi.main(args);
    const exitCode = process.exitCode;
    return typeof exitCode === 'number' ? exitCode : Number.parseInt(exitCode ?? '0', 10);
  } finally {
    restoreSettings();
  }
}

function formatDpiInitResult(result: RepositoryDoomInitResult): string {
  return [
    `DoomPi repository configuration: ${result.directory}`,
    ...(result.created.length > 0 ? [`created:  ${result.created.join(', ')}`] : []),
    ...(result.preserved.length > 0 ? [`kept:     ${result.preserved.join(', ')}`] : []),
    ...(result.replaced.length > 0 ? [`replaced: ${result.replaced.join(', ')}`] : []),
    '',
    'Run `dpi sync` next.',
    '',
  ].join('\n');
}

/** Seeds repository-local DoomPi configuration without registering anything with Pi. */
export function runDpiInit(
  args: string[],
  currentDirectory = process.cwd(),
  output: Pick<NodeJS.WritableStream, 'write'> = process.stdout,
): number {
  const flags = args.slice(1);
  const unknown = flags.find((flag) => flag !== FORCE_FLAG);
  if (unknown !== undefined) throw new Error(`dpi init does not accept ${unknown}`);

  const result = initializeRepositoryDoomConfig(currentDirectory, { force: flags.includes(FORCE_FLAG) });
  output.write(formatDpiInitResult(result));
  return 0;
}

/** Runs DPI's private build → sync pipeline without persisting the settings overlay. */
export async function runDpiSync(args: string[]): Promise<number> {
  const { SyncPipeline } = await import('../commands/syncPipeline.ts');
  return new SyncPipeline({ settingsMode: 'embedded' }).execute(args);
}

const DEFAULT_DEPENDENCIES: DpiRunnerDependencies = {
  init: runDpiInit,
  launchPi: launchDpiPi,
  sync: runDpiSync,
};

/** Dispatches DPI-owned setup commands and forwards every other argument to Pi. */
export async function runDpi(
  args: string[],
  dependencies: DpiRunnerDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  if (args[0] === INIT_COMMAND) return dependencies.init(args);
  if (args[0] === SYNC_COMMAND) return dependencies.sync(args);
  return dependencies.launchPi(args);
}
