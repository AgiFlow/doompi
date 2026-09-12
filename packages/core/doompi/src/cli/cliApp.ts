import type { HarnessTelemetry } from '@agimon-ai/doompi-core/runtime-log-sink-telemetry';
import type { HarnessOptions } from '../composition/types/harness';
import type { BaseCommand } from './commands/baseCommand';
import { HARNESS_VERSION, printHelp } from './help';
import { parseHarnessArgs } from './options';

/**
 * Main CLI Application
 *
 * Owns command registration and dispatch. Preparation is shared: the context
 * is built once and handed to whichever command claims the run.
 */
async function selectHarnessCommand(
  options: HarnessOptions,
): Promise<
  (context: import('../builders/cli/harnessContext').HarnessContext, telemetry: HarnessTelemetry) => Promise<number>
> {
  if (options.emitMcp) return (await import('./commands/emit-mcp')).runEmitMcp;
  if (options.explain) return (await import('./commands/explain')).runExplain;
  if (options.sandbox) return (await import('./commands/sandbox')).runSandbox;
  return (await import('./commands/launch')).runLaunch;
}
async function selectLegacyCommand(options: HarnessOptions): Promise<BaseCommand> {
  if (options.emitMcp) {
    const { EmitMcpCommand } = await import('./commands/emit-mcp');
    return new EmitMcpCommand();
  }
  if (options.explain) {
    const { ExplainCommand } = await import('./commands/explain');
    return new ExplainCommand();
  }
  if (options.sandbox) {
    const { SandboxLaunchCommand } = await import('./commands/sandbox');
    return new SandboxLaunchCommand();
  }
  const { LaunchCommand } = await import('./commands/launch');
  return new LaunchCommand();
}
function createCliApplication(initialTelemetry?: HarnessTelemetry) {
  let telemetry = initialTelemetry;
  let ownsTelemetry = false;
  async function getTelemetry(): Promise<HarnessTelemetry> {
    if (telemetry) return telemetry;
    const { createHarnessTelemetry } = await import('@agimon-ai/doompi-core/runtime-log-sink-telemetry');
    // Telemetry's transport graph costs roughly one launcher budget slice by
    // itself. Startup callbacks and lifecycle events buffer until shutdown, so
    // transport initialization cannot compete with the Pi child for input.
    telemetry = createHarnessTelemetry({ deferSpans: true });
    ownsTelemetry = true;
    return telemetry;
  }

  async function runHarness(options: HarnessOptions): Promise<number> {
    const telemetry = await getTelemetry();
    const [{ buildHarnessContext }, { ensureLayerPackages }, { HARNESS_EVENT }] = await Promise.all([
      import('../builders/cli/harnessContext'),
      import('../composition/layerPackageInstaller'),
      import('@agimon-ai/doompi-core/runtime-log-sink-telemetry'),
    ]);
    return telemetry.runInSpan(
      'doom_pi.run',
      {
        'harness.major_mode': options.majorMode,
        'harness.domain_count': options.domains.length,
        'harness.agents': options.agents,
        'harness.mcp': options.mcp,
        'harness.hooks': options.hooks,
        ...(options.profile ? { 'harness.profile': options.profile } : {}),
        ...(options.preset ? { 'harness.preset': options.preset } : {}),
      },
      async () => {
        const context = await buildHarnessContext(options, telemetry);
        try {
          await ensureLayerPackages({
            repoRoot: options.repoRoot,
            config: context.majorModesConfig,
            layers: context.selectedLayers,
            environment: context.environment,
          });
          const command = await selectHarnessCommand(context.options);
          // Selection uses the same resolved options used to build the context.
          return await command(context, telemetry);
        } catch (error) {
          await telemetry.recordError(HARNESS_EVENT.cliFailed, error);
          throw error;
        } finally {
          await context.cleanup();
        }
      },
    );
  }

  async function run(args: string[]): Promise<number> {
    if (args[0] === 'init') {
      const { runInit } = await import('./commands/init');
      return runInit(args);
    }
    // Sync owns the private cache build and then commits the resolved matrix for
    // plain Pi. Keeping both phases behind one command avoids stale partial setup.
    if (args[0] === 'sync') {
      const [{ runSync }, telemetry] = await Promise.all([import('./commands/sync/workflow'), getTelemetry()]);
      return runSync(args, undefined, undefined, undefined, { telemetry });
    }
    if (args[0] === 'doctor') {
      const { runDoctor } = await import('./commands/doctor');
      return runDoctor(args);
    }
    if (args[0] === 'compat') {
      const [{ runCompatibility }, telemetry] = await Promise.all([import('./commands/compat'), getTelemetry()]);
      return runCompatibility(args, undefined, undefined, telemetry);
    }
    if (args[0] === 'history-export') {
      const { runHistoryExport } = await import('./commands/history-export');
      return runHistoryExport(args);
    }
    if (args[0] === 'history-import') {
      const { runHistoryImport } = await import('./commands/history-import');
      return runHistoryImport(args);
    }

    // The first pass resolves --cwd without touching repository configuration,
    // which keeps help and version available even when modes.yaml is malformed.
    const initial = parseHarnessArgs(args);
    if (initial.help) {
      printHelp();
      return 0;
    }
    if (initial.version) {
      process.stdout.write(`${HARNESS_VERSION}\n`);
      return 0;
    }
    const telemetry = await getTelemetry();
    const [{ resolveHarnessOptions }, { toFailureReporter }] = await Promise.all([
      import('./harnessOptions'),
      import('@agimon-ai/doompi-core/runtime-log-sink-telemetry'),
    ]);
    return runHarness(resolveHarnessOptions({ args, report: toFailureReporter(telemetry) }));
  }

  async function shutdown(): Promise<void> {
    if (ownsTelemetry) await telemetry?.shutdown();
  }
  return { run, runHarness, shutdown };
}
/** Public compatibility API; execution is implemented by the application functions. */
export class CliApp {
  private readonly app: ReturnType<typeof createCliApplication>;
  constructor(telemetry?: HarnessTelemetry) {
    this.app = createCliApplication(telemetry);
  }
  selectCommand(options: HarnessOptions): Promise<BaseCommand> {
    return selectLegacyCommand(options);
  }
  runHarness(options: HarnessOptions): Promise<number> {
    return this.app.runHarness(options);
  }
  run(args: string[]): Promise<number> {
    return this.app.run(args);
  }
  shutdown(): Promise<void> {
    return this.app.shutdown();
  }
}

/**
 * Convenience wrapper kept so the binary and tests need no CliApp knowledge.
 *
 * Telemetry is shut down here rather than inside runHarness, because this is
 * the only scope that owns the process: flushing earlier would drop the records
 * a later command still emits.
 */
export async function runCli(args: string[]): Promise<number> {
  const app = createCliApplication();
  try {
    return await app.run(args);
  } finally {
    await app.shutdown();
  }
}

/** Runs an already-resolved option set, skipping argument parsing. */
export async function runHarness(options: HarnessOptions): Promise<number> {
  const app = createCliApplication();
  try {
    return await app.runHarness(options);
  } finally {
    await app.shutdown();
  }
}
