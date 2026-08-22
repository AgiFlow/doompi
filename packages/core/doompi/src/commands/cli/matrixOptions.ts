import path from 'node:path';

/**
 * Matrix selection shared by the Pi and compatibility parsers.
 *
 * Both frontends pick the same three axes (profile, domains, major mode) out of
 * the same environment variables with the same defaults. They used to hold two
 * copies of that logic, and the copies drifted: the inline `--name=value` forms
 * and the strict value reader existed in the compatibility parser only, so
 * `./pi.sh --profile=x` silently forwarded an unknown flag to Pi. One copy here
 * is what keeps them honest.
 */

/**
 * One variable per axis.
 *
 * These used to come in pairs, `DOOM_PI_*` for what the caller selected and
 * `DOOMPI_*` for what the harness resolved and published, with the second
 * outranking the first. A nested run still inherits its launcher's choice under
 * one name, because the launcher projects into the child environment and
 * overwrites the same key. Two names for one value only ever meant two ways to
 * disagree.
 */
export const DOOMPI_PROFILE_ENV = 'DOOMPI_PROFILE';
export const DOOMPI_DOMAINS_ENV = 'DOOMPI_DOMAINS';
export const DOOMPI_MAJOR_MODE_ENV = 'DOOMPI_MAJOR_MODE';
export const DOOMPI_ADDITIONAL_DIRECTORIES_ENV = 'DOOMPI_ADDITIONAL_DIRS';
export const DOOMPI_PRESET_ENV = 'DOOMPI_PRESET';

/** Removed spelling of the major mode axis, reported rather than honored. */
export const REMOVED_DOOMPI_LAYER_ENV = 'DOOMPI_LAYER';

/**
 * The whole retired namespace, reported rather than ignored.
 *
 * A prefix scan rather than a constant per variable: there were 28 of them, and
 * a list maintained by hand is a list that misses one. A stale
 * `export AGENT_HARNESS_MAJOR_MODE=dev` in a shell profile would otherwise
 * silently start the session on `copilot`.
 */
const RETIRED_ENV_PREFIX = 'AGENT_HARNESS_';
const CURRENT_ENV_PREFIX = 'DOOMPI_';

export const PROFILE_OPTION = '--profile';
export const DOMAIN_OPTION = '--domain';
export const DOMAINS_OPTION = '--domains';
/**
 * The major mode flag.
 *
 * Not `--mode`: Pi owns that one for its output mode, and for a value outside
 * `text|json|rpc` it consumes both tokens and ignores them without a
 * diagnostic. A synced `pi --mode dev` would have failed silently.
 */
export const MAJOR_MODE_OPTION = '--major-mode';
export const ADD_DIRECTORY_OPTION = '--add-dir';
export const REMOVED_LAYER_OPTION = '--layer';
export const REMOVED_LAYERS_OPTION = '--layers';
export const REMOVED_TARGET_OPTION = '--target';

export const DEFAULT_MAJOR_MODE = 'copilot';
export const DEFAULT_DOMAIN = 'default';

const CSV_DELIMITER = ',';
const OPTION_PREFIX = '--';

export interface OptionMatch {
  value: string;
  /** Index of the last argument consumed, for the caller's loop cursor. */
  nextIndex: number;
  /** True for `--name=value`. Callers that re-emit an option preserve the form. */
  inline: boolean;
}

/**
 * Reads `--name value` or `--name=value`, returning undefined for anything else.
 *
 * A value starting with `--` is rejected rather than consumed, so
 * `--profile --explain` reports a missing value instead of swallowing the next
 * flag. In compatibility mode this is also what stops the `--` provider
 * delimiter being taken as a matrix value.
 */
export function readOption(args: string[], index: number, name: string): OptionMatch | undefined {
  // Callers walk `args` by index, so this is always in range.
  const arg = args[index]!;
  if (arg === name) {
    const value = args[index + 1];
    if (!value || value.startsWith(OPTION_PREFIX)) throw new Error(`${name} requires a value`);
    return { value, nextIndex: index + 1, inline: false };
  }
  const inlinePrefix = `${name}=`;
  if (!arg.startsWith(inlinePrefix)) return undefined;
  const value = arg.slice(inlinePrefix.length);
  if (!value) throw new Error(`${name} requires a value`);
  return { value, nextIndex: index, inline: true };
}

/** Matches `--name` or `--name=value`, for reporting options that were removed. */
export function matchesOption(arg: string, name: string): boolean {
  return arg === name || arg.startsWith(`${name}=`);
}

export function parseCsv(value: string): string[] {
  return value
    .split(CSV_DELIMITER)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseRequiredCsv(value: string, option: string): string[] {
  const values = parseCsv(value);
  if (values.length === 0) throw new Error(`${option} requires a value`);
  return values;
}

export function parseMajorMode(value: string, source: string): string {
  const majorMode = value.trim();
  if (!majorMode) throw new Error(`${source} requires a value`);
  if (majorMode.includes(CSV_DELIMITER)) throw new Error(`${source} accepts one major mode name`);
  return majorMode;
}

export function parseProfileValue(value: string, source: string): string {
  if (value.includes(CSV_DELIMITER)) throw new Error(`${source} accepts one profile name`);
  if (!value.trim()) throw new Error(`${source} requires a value`);
  return value;
}

/**
 * Reports any variable left over from the retired `AGENT_HARNESS_*` namespace.
 *
 * Called before anything reads the environment, so a stale export fails the
 * session instead of being quietly outvoted by a default. Both prefixes are
 * built from the constants above rather than written inline, because a
 * search-and-replace over this repository is exactly what retired the old one.
 */
export function assertNoRetiredEnvironment(environment: NodeJS.ProcessEnv): void {
  const stale = Object.keys(environment)
    .filter((key) => key.startsWith(RETIRED_ENV_PREFIX))
    .sort();
  if (stale.length === 0) return;
  const replacements = stale.map((key) => `${key} -> ${CURRENT_ENV_PREFIX}${key.slice(RETIRED_ENV_PREFIX.length)}`);
  throw new Error(
    `The ${RETIRED_ENV_PREFIX}* environment was replaced by ${CURRENT_ENV_PREFIX}*. Unset or rename: ${replacements.join(', ')}`,
  );
}

/**
 * The major mode a nested run inherits from its launcher, or the default.
 *
 * The removed spelling throws rather than being ignored. A stale
 * `export DOOMPI_LAYER=dev` left in a shell profile would otherwise silently
 * select `copilot`, which is the exact confusion the rename removed.
 */
export function resolveInheritedMajorMode(
  environment: NodeJS.ProcessEnv,
  defaultMajorMode: string = DEFAULT_MAJOR_MODE,
): string {
  assertNoRetiredEnvironment(environment);
  if (environment[REMOVED_DOOMPI_LAYER_ENV]) {
    throw new Error(`${REMOVED_DOOMPI_LAYER_ENV} was replaced by ${DOOMPI_MAJOR_MODE_ENV}`);
  }
  const inherited = environment[DOOMPI_MAJOR_MODE_ENV];
  return parseMajorMode(inherited || defaultMajorMode, inherited ? DOOMPI_MAJOR_MODE_ENV : 'defaultMajorMode');
}

/** The profile a run inherits from its environment, validated once up front. */
export function resolveInheritedProfile(environment: NodeJS.ProcessEnv): string | undefined {
  const inherited = environment[DOOMPI_PROFILE_ENV] || undefined;
  if (inherited?.includes(CSV_DELIMITER)) throw new Error(`${DOOMPI_PROFILE_ENV} accepts one profile name`);
  return inherited;
}

/** Directories inherited from the launcher environment. */
export function resolveAdditionalDirectories(environment: NodeJS.ProcessEnv, baseDirectory: string): string[] {
  return (environment[DOOMPI_ADDITIONAL_DIRECTORIES_ENV] ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.resolve(baseDirectory, directory));
}
