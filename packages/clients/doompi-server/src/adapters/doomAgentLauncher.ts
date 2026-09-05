import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { resolveHarnessOptions } from '@agimon-ai/doompi/cli';
import { createHarnessTelemetry, type HarnessTelemetry } from '@agimon-ai/doompi/logSinkTelemetry';
import {
  buildHarnessContext,
  ensureLayerPackages,
  type HarnessContext,
  resolveLaunchPlan,
} from '@agimon-ai/doompi/services';
import { piCliPath } from '@agimon-ai/doompi/utils';
import { relaunchAgentArgs } from '../services/serveOptions.ts';
import type { AgentLauncher, AgentProcessOptions } from '../types/session.ts';

const REPO_LOCAL_PACKAGE = ['node_modules', '@agimon-ai', 'doompi'];
const CLI_SEGMENTS = ['dist', 'bin', 'cli.mjs'];
const AGENT_COMMAND_ENV = 'DOOMPI_AGENT_COMMAND';
const NODE_SCRIPT_SUFFIXES = ['.mjs', '.js'];

type FileExists = (file: string) => boolean;

/** Splits a configured launcher into a spawnable command, running scripts under this node. */
function launcherCommand(configured: string): { command: string; prefixArgs: string[] } {
  return NODE_SCRIPT_SUFFIXES.some((suffix) => configured.endsWith(suffix))
    ? { command: process.execPath, prefixArgs: [configured] }
    : { command: configured, prefixArgs: [] };
}

function canonical(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/** The directory of the DoomPi this server composes with. */
function ownPackageDirectory(parentUrl: string): string | undefined {
  try {
    return path.dirname(createRequire(parentUrl).resolve('@agimon-ai/doompi/package.json'));
  } catch {
    // A server running from source has no resolvable manifest; in-process
    // composition is then the only path, which is what returning undefined does.
    return undefined;
  }
}

/**
 * The CLI of a DoomPi the session's repository pins to a different install.
 *
 * Extensions are version-coupled to the harness that loads them, so a
 * repository pinning its own DoomPi must run that one. Composing in process
 * would silently substitute this server's copy. When the repository resolves
 * to the very package this server already imports there is nothing to
 * delegate to, and the in-process path applies.
 *
 * An unresolvable own directory delegates rather than composing, because a
 * version that cannot be compared is not a version known to match.
 */
export function pinnedDoomPiCli(
  cwd: string,
  own: string | undefined = ownPackageDirectory(import.meta.url),
  exists: FileExists = fs.existsSync,
): string | undefined {
  for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, ...REPO_LOCAL_PACKAGE);
    if (exists(path.join(candidate, 'package.json'))) {
      if (own !== undefined && canonical(candidate) === canonical(own)) return undefined;
      const cli = path.join(candidate, ...CLI_SEGMENTS);
      return exists(cli) ? cli : undefined;
    }
    if (directory === path.dirname(directory)) return undefined;
  }
}

export interface DoomAgentLauncherOptions {
  /** Launcher arguments for this session, as they appeared after `--`. */
  agentArgs: readonly string[];
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  telemetry?: HarnessTelemetry;
  onNotice?: (message: string) => void;
  /**
   * Where to record the composition so a mode switch reloads in place.
   *
   * Without it the session behaves as before: Pi is handed the aggregate and
   * a mode switch needs a new process.
   */
  compositionRecordPath?: string;
  /** Test seam for the repository pin lookup. */
  resolvePinnedCli?: (cwd: string) => string | undefined;
}

/**
 * Composes this session's extension matrix in process and points Pi at it.
 *
 * The launcher CLI used to sit between the server and Pi purely to run this
 * sequence, then wait for a child it had nothing left to say to. Calling the
 * same published preparation directly removes that process without changing
 * what Pi is handed: the argument vector is built by the launcher's own code.
 */
export function createDoomAgentLauncher(options: DoomAgentLauncherOptions): AgentLauncher {
  const environment = options.environment ?? process.env;
  const telemetry = options.telemetry ?? createHarnessTelemetry({ deferSpans: true });
  let context: HarnessContext | undefined;

  const releaseContext = async (): Promise<void> => {
    const previous = context;
    context = undefined;
    if (!previous) return;
    try {
      await previous.cleanup();
    } catch (error) {
      // A stranded staging directory must not take the session down with it.
      options.onNotice?.(`could not clean up the previous composition: ${describe(error)}`);
    }
  };

  // The repository owns its session composition. The configured launcher is the
  // complete global fallback when that repository does not pin DoomPi.
  const resolvePinnedCli = options.resolvePinnedCli ?? ((cwd: string) => pinnedDoomPiCli(cwd));
  const pinned = resolvePinnedCli(options.cwd);
  const configured = environment[AGENT_COMMAND_ENV];
  const delegate = pinned === undefined ? (configured ? launcherCommand(configured) : undefined) : toDelegate(pinned);
  if (delegate !== undefined) {
    options.onNotice?.(
      `composing through ${pinned === undefined ? 'the configured' : "this repository's"} DoomPi launcher`,
    );
  }

  return {
    async resolve(majorMode) {
      await releaseContext();
      const args = majorMode === undefined ? [...options.agentArgs] : relaunchAgentArgs(options.agentArgs, majorMode);
      // The delegated launcher owns composition for its own version, so it is
      // handed the arguments unchanged and does the work in its own process.
      if (delegate !== undefined) {
        return {
          command: delegate.command,
          args: [...delegate.prefixArgs, ...args],
          cwd: options.cwd,
          env: environment,
        };
      }
      const harnessOptions = resolveHarnessOptions({ args, environment, cwd: options.cwd });
      const built = await buildHarnessContext(harnessOptions, telemetry);
      context = built;
      await ensureLayerPackages({
        repoRoot: harnessOptions.repoRoot,
        config: built.majorModesConfig,
        layers: built.selectedLayers,
        environment: built.environment,
      });
      const plan = await resolveLaunchPlan(
        built,
        telemetry,
        options.compositionRecordPath === undefined ? {} : { compositionRecordPath: options.compositionRecordPath },
      );
      return {
        command: process.execPath,
        args: [piCliPath(), ...plan.piArgs],
        cwd: harnessOptions.cwd,
        env: plan.environment,
      } satisfies AgentProcessOptions;
    },
    cleanup: releaseContext,
  };
}

function toDelegate(cli: string | undefined): { command: string; prefixArgs: string[] } | undefined {
  return cli === undefined ? undefined : { command: process.execPath, prefixArgs: [cli] };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
