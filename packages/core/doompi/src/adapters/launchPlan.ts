import { randomUUID } from 'node:crypto';
import { DOOMPI_EXTENSIONS_PROVIDED_ENV } from '@agimon-ai/doompi-extension-contracts/child-process';
import { updateHarnessState } from './config/harnessState.ts';
import { writeLauncherComposition } from './launcherComposition.ts';
import { ownEntry } from './modules/moduleResolution';
import { HARNESS_EVENT, type HarnessTelemetry } from './telemetry/logSinkTelemetry.ts';
import { applyProjectTrust, hasProjectTrustOption, loadDoomConfig } from '../services/config/projectTrust';
import type { DoomConfig } from '../services/config/projectTrust';
import { LAUNCHER_COMPOSITION_ENV, LAUNCHER_COMPOSITION_VERSION } from '../types/interfaces/launcherComposition';
import type { HarnessContext } from './harnessContext.ts';

const LAUNCHER_BOOTSTRAP_ENTRY = 'launcherBootstrap';

const EXTENSION_OPTION = '--extension';
const THEME_OPTION = '--theme';
const NO_THEMES_OPTION = '--no-themes';
const ENABLED_ENV = '1';
const ELICITATION_SESSION_ENV = 'ELICITATION_SESSION_ID';

/** Gives each Doompi launch a stable fallback identity without replacing one supplied by its caller. */
export function ensureElicitationSessionId(environment: NodeJS.ProcessEnv): string {
  const provided = environment[ELICITATION_SESSION_ENV]?.trim();
  const sessionId = provided || randomUUID();
  environment[ELICITATION_SESSION_ENV] = sessionId;
  return sessionId;
}

/** Ignores configured themes and loads only themes explicitly passed to the launcher. */
export function overridePiThemes(piArgs: string[], themePath: string): string[] {
  return [NO_THEMES_OPTION, THEME_OPTION, themePath, ...piArgs];
}

export interface ResolveLaunchPlanOptions {
  /**
   * Where to record this session's composition, enabling reload-time recomposition.
   *
   * Pi is then given one stable entry instead of the fingerprint-named
   * aggregate, so a `/mode` switch can reload in place rather than requiring a
   * new process. Omit it to hand Pi the aggregate directly, which is the
   * historical behaviour and freezes the composition for the process.
   */
  compositionRecordPath?: string;
}

export interface PiLaunchPlan {
  /** Complete argument vector for Pi, extension activation first. */
  piArgs: string[];
  /** Environment the Pi process must run with. */
  environment: NodeJS.ProcessEnv;
  /** The compiled aggregate, or undefined when compilation fell back to individual entries. */
  bundle?: string;
  /** Canonical composition identity for this launch. */
  fingerprint: string;
  /** Entries a detached child agent inherits. */
  childExtensions: string[];
  /** Extension entries in Pi factory activation order. */
  extensions: string[];
}

/**
 * Resolves everything Pi needs to start, short of spawning it.
 *
 * The launcher and the session server both need this exact sequence, and a
 * second copy would drift the moment either gains a step. Spawning is left to
 * the caller because that is the only part they disagree on: the launcher
 * inherits a terminal, the server owns pipes.
 */
export async function resolveLaunchPlan(
  context: HarnessContext,
  telemetry: HarnessTelemetry,
  planOptions: ResolveLaunchPlanOptions = {},
): Promise<PiLaunchPlan> {
  const { options, environment } = context;
  ensureElicitationSessionId(environment);

  const { buildRuntimeBundle, createRuntimeExtensionPlan } = await import('./runtimeBundle.ts');
  const extensionPlan = createRuntimeExtensionPlan(context);
  const { extensions, childExtensions } = extensionPlan;
  updateHarnessState(
    {
      childExtensions,
      compositionFingerprint: extensionPlan.fingerprint,
    },
    environment,
  );

  // Pi normally imports each package entry separately. Flattening the exact
  // Pi load order into one graph removes repeated module resolution and parse
  // work. The graph manifest makes the common path a stat-only cache hit;
  // compilation failure keeps the historical extension list intact.
  let launchExtensions = extensions;
  let bundle: string | undefined;
  try {
    const built = await buildRuntimeBundle(context, extensionPlan);
    launchExtensions = [built.bundle];
    bundle = built.bundle;
    // A synced repository also has the doom wrapper in project settings. It
    // must not compose the same factories after this aggregate has run.
    environment[DOOMPI_EXTENSIONS_PROVIDED_ENV] = ENABLED_ENV;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[doompi] extension bundle unavailable; using individual entries: ${detail}\n`);
  }

  // Recording the composition swaps the fingerprint-named aggregate for one
  // stable entry that resolves the selection every time it loads, which is
  // what lets a mode switch reload instead of taking a new process. The
  // aggregate is still built: it becomes the fast path this entry looks up.
  if (planOptions.compositionRecordPath !== undefined) {
    writeLauncherComposition(planOptions.compositionRecordPath, {
      version: LAUNCHER_COMPOSITION_VERSION,
      root: options.repoRoot,
      preset: options.preset,
      mute: options.mute,
      autoStop: options.autoStop,
      agents: options.agents,
      ...(bundle === undefined ? { bundles: {} } : { bundles: { [extensionPlan.fingerprint]: bundle } }),
    });
    environment[LAUNCHER_COMPOSITION_ENV] = planOptions.compositionRecordPath;
    environment[DOOMPI_EXTENSIONS_PROVIDED_ENV] = ENABLED_ENV;
    launchExtensions = [ownEntry(LAUNCHER_BOOTSTRAP_ENTRY)];
  }

  // A malformed .doom/config.yaml aborts the launch, and the message only
  // reaches the terminal that ran it, so record it before it propagates.
  let doomConfig: DoomConfig;
  try {
    doomConfig = loadDoomConfig(options.repoRoot);
  } catch (error) {
    await telemetry.recordError(HARNESS_EVENT.configLoadFailed, error, { 'harness.phase': 'load_config' });
    throw error;
  }

  // Whether a session ran with repository approval is the single most useful
  // fact when reconstructing what an agent was allowed to do.
  void telemetry.recordEvent(HARNESS_EVENT.projectTrustResolved, {
    'harness.project_trust': doomConfig.projectTrust,
    'harness.project_trust.overridden': hasProjectTrustOption(options.piArgs),
  });

  let piArgs = applyProjectTrust(options.piArgs, doomConfig);
  piArgs = overridePiThemes(piArgs, context.defaultThemePath);
  // launchExtensions is canonical factory activation order. Keep CLI argument
  // adaptation here rather than leaking reversal rules into composition.
  piArgs = [...launchExtensions.flatMap((extension) => [EXTENSION_OPTION, extension]), ...piArgs];

  return {
    piArgs,
    environment,
    bundle,
    fingerprint: extensionPlan.fingerprint,
    childExtensions,
    extensions: launchExtensions,
  };
}
