import type { HarnessTelemetry } from '@agimon-ai/doompi-core/runtime-log-sink-telemetry';
import type { HarnessContext } from '../../builders/cli/harnessContext';
import type { HarnessOptions } from '../../composition/types/harness';

/** Public compatibility contract for callers that use command classes. */
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
