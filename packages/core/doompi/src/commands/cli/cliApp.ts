import type { HarnessTelemetry } from '../../adapters/telemetry/logSinkTelemetry.ts';
import type { HarnessOptions } from '../../types/interfaces/harness';
import type { BaseCommand } from '../baseCommand.ts';
import { HARNESS_VERSION, printHelp } from './help.ts';
import { parseHarnessArgs } from './options.ts';

/**
 * Main CLI Application
 *
 * Owns command registration and dispatch. Preparation is shared: the context
 * is built once and handed to whichever command claims the run.
 */
export class CliApp {
  private telemetry: HarnessTelemetry | undefined;
  private ownsTelemetry = false;

  // Fields are declared and assigned explicitly rather than as constructor
  // parameter properties: the launcher scripts run this file straight from
  // source under Node's strip-only TypeScript mode, which rejects them.
  constructor(telemetry?: HarnessTelemetry) {
    this.telemetry = telemetry;
  }

  /** Creates telemetry only for commands that actually report a run. */
  private async getTelemetry(): Promise<HarnessTelemetry> {
    if (this.telemetry) return this.telemetry;
    const { createHarnessTelemetry } = await import('../../adapters/telemetry/logSinkTelemetry.ts');
    // Telemetry's transport graph costs roughly one launcher budget slice by
    // itself. Startup callbacks and lifecycle events buffer until shutdown, so
    // transport initialization cannot compete with the Pi child for input.
    this.telemetry = createHarnessTelemetry({ deferSpans: true });
    this.ownsTelemetry = true;
    return this.telemetry;
  }

  /** Picks and imports only the command the parsed options select. */
  async selectCommand(options: HarnessOptions): Promise<BaseCommand> {
    if (options.emitMcp) {
      const { EmitMcpCommand } = await import('../emitMcpCommand.ts');
      return new EmitMcpCommand();
    }
    if (options.explain) {
      const { ExplainCommand } = await import('../explainCommand.ts');
      return new ExplainCommand();
    }
    if (options.sandbox) {
      const { SandboxLaunchCommand } = await import('../sandboxLaunchCommand.ts');
      return new SandboxLaunchCommand();
    }
    const { LaunchCommand } = await import('../launchCommand.ts');
    return new LaunchCommand();
  }

  /**
   * Builds the context, runs the selected command, and always cleans up.
   *
   * The whole run is one span so the sink shows preparation and the child
   * process as a single timeline: a slow launch is almost always a slow stage
   * inside here, and that is only visible when the stages share a trace.
   */
  async runHarness(options: HarnessOptions): Promise<number> {
    const telemetry = await this.getTelemetry();
    const [{ buildHarnessContext }, { ensureLayerPackages }, { HARNESS_EVENT }] = await Promise.all([
      import('../../adapters/harnessContext'),
      import('../../adapters/layerPackageInstaller.ts'),
      import('../../adapters/telemetry/logSinkTelemetry.ts'),
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
          const command = await this.selectCommand(context.options);
          // Selection uses the same resolved options used to build the context.
          return await command.execute(context, telemetry);
        } catch (error) {
          await telemetry.recordError(HARNESS_EVENT.cliFailed, error);
          throw error;
        } finally {
          await context.cleanup();
        }
      },
    );
  }

  /** Entry point for raw process arguments. */
  async run(args: string[]): Promise<number> {
    if (args[0] === 'init') {
      const { InitCommand } = await import('../initCommand.ts');
      return new InitCommand().execute(args);
    }
    // Sync owns the private cache build and then commits the resolved matrix for
    // plain Pi. Keeping both phases behind one command avoids stale partial setup.
    if (args[0] === 'sync') {
      const [{ SyncPipeline }, telemetry] = await Promise.all([import('../syncPipeline.ts'), this.getTelemetry()]);
      return new SyncPipeline({ telemetry }).execute(args);
    }
    if (args[0] === 'compat') {
      const [{ CompatibilityCommand }, telemetry] = await Promise.all([
        import('../compatibilityCommand.ts'),
        this.getTelemetry(),
      ]);
      return new CompatibilityCommand(telemetry).execute(args);
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
    const telemetry = await this.getTelemetry();
    const [{ resolveHarnessOptions }, { toFailureReporter }] = await Promise.all([
      import('./harnessOptions.ts'),
      import('../../adapters/telemetry/logSinkTelemetry.ts'),
    ]);
    return this.runHarness(resolveHarnessOptions({ args, report: toFailureReporter(telemetry) }));
  }

  /** Flushes telemetry if this application created it lazily. */
  async shutdown(): Promise<void> {
    if (this.ownsTelemetry) await this.telemetry?.shutdown();
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
  const app = new CliApp();
  try {
    return await app.run(args);
  } finally {
    await app.shutdown();
  }
}

/** Runs an already-resolved option set, skipping argument parsing. */
export async function runHarness(options: HarnessOptions): Promise<number> {
  const app = new CliApp();
  try {
    return await app.runHarness(options);
  } finally {
    await app.shutdown();
  }
}
