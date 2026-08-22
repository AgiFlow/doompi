import type { HarnessTelemetry } from '../adapters/telemetry/logSinkTelemetry.ts';
import type { HarnessContext } from '../adapters/harnessContext';
import type { HarnessOptions } from '../types/interfaces/harness';

/**
 * Base Command
 *
 * All doom-pi commands extend this to keep a consistent shape.
 *
 * This deviates from the cli-lib template in one way: there is no
 * register(program) and no Commander.js. doom-pi is a passthrough launcher,
 * where every argument it does not recognise belongs to Pi, so a subcommand
 * parser would reject Pi's own flags. Commands are selected by inspecting the
 * already-parsed options instead, which keeps the Command pattern without
 * taking over argument parsing.
 */
export abstract class BaseCommand {
  /** Identifier used in diagnostics and tests. */
  abstract readonly name: string;

  /** True when the parsed options select this command. */
  abstract matches(options: HarnessOptions): boolean;

  /**
   * Runs the command and resolves to the process exit code.
   *
   * Telemetry is handed in rather than created per command so every stage of
   * one run reports under the same span.
   */
  abstract execute(context: HarnessContext, telemetry: HarnessTelemetry): Promise<number>;

  /**
   * Handle errors consistently across all commands.
   */
  protected handleError(error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[doompi] ${this.name}: ${message}\n`);
    process.exit(1);
  }
}
