import path from 'node:path';
import {
  createHarnessTelemetry,
  HARNESS_EVENT,
  type HarnessTelemetry,
} from '@agimon-ai/doompi-core/runtime-log-sink-telemetry';
import { loadDomains } from '@agimon-ai/doompi-config/domains';
import { loadMajorModesConfig } from '@agimon-ai/doompi-config/majorModes';
import { launchCompatibility } from './providers';
import { buildCompatibilityContext } from './context';
import { findRepositoryRoot } from '../../../composition/repository';
import { isCompatibilityProvider, parseCompatibilityArgs, parseCompatibilityProvider } from './options';
import { compatHelp } from './help';
import { wantsHelp } from '../../router';

const COMPAT_COMMAND = 'compat';
const HARNESS_ROOT_ENV = 'DOOMPI_ROOT';

/** Launches a non-Pi frontend with the doom-pi matrix resolved for that run. */
export async function runCompatibility(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  currentDirectory = process.cwd(),
  telemetry: HarnessTelemetry = createHarnessTelemetry(),
): Promise<number> {
  // Only when no provider was named. Once one is, every remaining argument
  // belongs to that frontend, so `compat claude --help` is Claude's help.
  if (!isCompatibilityProvider(args[1]) && wantsHelp(args.slice(1))) {
    process.stdout.write(compatHelp());
    return 0;
  }
  const provider = parseCompatibilityProvider(args[1]);
  const inheritedRoot = environment[HARNESS_ROOT_ENV];
  const repoRoot = inheritedRoot ? path.resolve(inheritedRoot) : findRepositoryRoot(currentDirectory);
  const parsed = parseCompatibilityArgs(
    args.slice(2),
    environment,
    currentDirectory,
    loadMajorModesConfig(repoRoot).defaultMajorMode,
    loadDomains(repoRoot).defaultDomains,
  );
  const startedAt = Date.now();

  // Compatibility launches shell out to a third-party CLI and to state-sync
  // scripts, so most of what can go wrong here is invisible to Pi entirely.
  return telemetry.runInSpan(
    'doom_pi.compatibility',
    { 'harness.provider': provider, 'harness.mode': 'compatibility' },
    async () => {
      const context = await buildCompatibilityContext({ repoRoot, provider, ...parsed.options });
      try {
        const exitCode = await launchCompatibility(context);
        void telemetry.recordEvent(HARNESS_EVENT.launchCompleted, {
          'harness.provider': provider,
          'harness.exit_code': exitCode,
          'harness.duration_ms': Date.now() - startedAt,
        });
        return exitCode;
      } catch (error) {
        await telemetry.recordError(HARNESS_EVENT.compatibilityLaunchFailed, error, {
          'harness.provider': provider,
          'harness.duration_ms': Date.now() - startedAt,
        });
        throw error;
      } finally {
        await context.cleanup();
      }
    },
  );
}

/** Compatibility API. Executables call the command function directly. */
export class CompatibilityCommand {
  readonly name = COMPAT_COMMAND;
  private readonly telemetry: HarnessTelemetry;

  // Not a constructor parameter property: the launcher scripts run this file
  // straight from source under Node's strip-only TypeScript mode, which
  // rejects them.
  constructor(telemetry: HarnessTelemetry = createHarnessTelemetry()) {
    this.telemetry = telemetry;
  }

  matches(args: string[]): boolean {
    return args[0] === this.name;
  }

  async execute(
    args: string[],
    environment: NodeJS.ProcessEnv = process.env,
    currentDirectory = process.cwd(),
  ): Promise<number> {
    return runCompatibility(args, environment, currentDirectory, this.telemetry);
  }
}
