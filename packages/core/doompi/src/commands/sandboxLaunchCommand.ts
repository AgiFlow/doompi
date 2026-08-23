import { insideSandbox, SANDBOX_HARNESS_EXPORT_SUBPATH } from '@agimon-ai/doompi-extension-contracts/sandbox-harness';
import { HARNESS_EVENT, type HarnessTelemetry } from '../adapters/telemetry/logSinkTelemetry.ts';
import type { HarnessContext } from '../adapters/harnessContext';
import type { HarnessOptions } from '../types/interfaces/harness';
import { BaseCommand } from './baseCommand.ts';

const SANDBOX_MODE = 'sandbox';

/**
 * Delegates a --sandbox launch to the harness a selected layer provides.
 *
 * Core stays sandbox-agnostic: it resolves the module the composition
 * declares, hands over the replayable arguments, and reports the exit code.
 */
export class SandboxLaunchCommand extends BaseCommand {
  readonly name = 'sandbox-launch';

  matches(options: HarnessOptions): boolean {
    return options.sandbox;
  }

  async execute(context: HarnessContext, telemetry: HarnessTelemetry): Promise<number> {
    const { options, environment } = context;
    if (insideSandbox(environment)) {
      throw new Error('This session already runs inside a DoomPi sandbox; nested --sandbox is not supported.');
    }

    const [{ loadSandboxHarness, resolveSandboxHarnessEntry }, { buildSandboxForwardArgs }] = await Promise.all([
      import('../adapters/sandboxHarness.ts'),
      import('./cli/sandboxArgs.ts'),
    ]);
    const resolution = resolveSandboxHarnessEntry(context.majorModesConfig, context.selectedLayers, options.repoRoot);
    if (!resolution) {
      throw new Error(
        `--sandbox needs a layer package exporting ${SANDBOX_HARNESS_EXPORT_SUBPATH} in the selected major mode; ` +
          `add a sandbox layer to "${options.majorMode}" in .doom/modes.yaml.`,
      );
    }

    const harness = await loadSandboxHarness(resolution.entry);
    const startedAt = Date.now();
    const result = await telemetry
      .runInSpan(
        'doom_pi.sandbox_session',
        { 'harness.mode': SANDBOX_MODE, 'harness.sandbox.provider': resolution.specifier },
        () =>
          harness.launchSandbox({
            repoRoot: options.repoRoot,
            cwd: options.cwd,
            forwardArgs: buildSandboxForwardArgs(options),
            environment,
            onProgress: (message) => process.stderr.write(`[doompi] sandbox: ${message}\n`),
          }),
      )
      .catch(async (error: unknown) => {
        await telemetry.recordError(HARNESS_EVENT.launchFailed, error, {
          'harness.mode': SANDBOX_MODE,
          'harness.duration_ms': Date.now() - startedAt,
        });
        throw error;
      });

    void telemetry.recordEvent(HARNESS_EVENT.launchCompleted, {
      'harness.exit_code': result,
      'harness.duration_ms': Date.now() - startedAt,
      'harness.mode': SANDBOX_MODE,
    });
    return result;
  }
}
