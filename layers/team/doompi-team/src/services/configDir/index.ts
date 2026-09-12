/**
 * Locating the coding agent's config directory.
 *
 * The directory is normally `.pi`, but a rebranded build of the coding agent
 * can rename it, so the real name is discovered from the running installation
 * rather than assumed. Discovery order runs from most to least authoritative:
 * the loaded module's own export, then an explicitly configured package root,
 * then a walk upward from the process entry point, then the default.
 *
 * DESIGN PATTERNS:
 * - Resolution is a pure function of its inputs; the process-wide convenience
 *   wrapper is a separate, memoized entry point
 * - Every discovery step is best-effort. A detached runner must still start
 *   when package metadata is unreadable, so failures fall through to the default
 *
 * PERFORMANCE:
 * `getConfigDirName` is memoized because the uncached path walks from the entry
 * point to the filesystem root, reading and parsing a package.json per level.
 * Callers join it into paths, so it was previously re-walked per path built.
 *
 * AVOID:
 * - Hardcoding `.pi` at a call site
 * - Calling the uncached resolver on a hot path
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DEFAULT_CONFIG_DIR_NAME = '.pi';
const PI_CODING_AGENT_PACKAGE_NAME = '@earendil-works/pi-coding-agent';
const AGENT_DIR_NAME = 'agent';
const HOME_ALIAS = '~';
const HOME_ALIAS_PREFIX = '~/';

/** Overrides the upward package walk when the installation root is known. */
export const PI_CODING_AGENT_PACKAGE_ROOT_ENV = 'PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT';

/**
 * Resolve a path through symlinks for use with a filesystem watcher.
 *
 * libuv's Windows watcher cannot mix an 8.3 short path used at registration
 * with the long paths it reports in events, so watchers register the real path.
 * An unresolvable path is returned unchanged; watching it may still work.
 */
export function resolveWatchPath(
  watchPath: string,
  nativeRealpath: (filePath: string) => string = fs.realpathSync.native,
): string {
  try {
    return nativeRealpath(watchPath);
  } catch {
    // The path may not exist yet, or realpath may be unsupported here.
    return watchPath;
  }
}

function validConfigDirName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Read the config dir name from a directory, if it is the coding agent's package root. */
function readConfigDirNameFromPackageRoot(packageRoot: string | undefined): string | undefined {
  if (!packageRoot) return undefined;
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf-8'));
    if (typeof manifest !== 'object' || manifest === null) return undefined;

    const record = manifest as { name?: unknown; piConfig?: unknown };
    if (record.name !== PI_CODING_AGENT_PACKAGE_NAME) return undefined;

    const piConfig =
      typeof record.piConfig === 'object' && record.piConfig !== null
        ? (record.piConfig as { configDir?: unknown })
        : undefined;
    return validConfigDirName(piConfig?.configDir);
  } catch {
    // Absent or malformed metadata simply means this is not the package root.
    return undefined;
  }
}

function resolveConfigDirNameFromPackageJson(
  entryPoint = process.argv[1],
  packageRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV],
): string | undefined {
  const configuredRootValue = readConfigDirNameFromPackageRoot(packageRoot);
  if (configuredRootValue) return configuredRootValue;
  if (!entryPoint) return undefined;

  try {
    let dir = path.dirname(fs.realpathSync(entryPoint));
    while (dir !== path.dirname(dir)) {
      const value = readConfigDirNameFromPackageRoot(dir);
      if (value) return value;
      dir = path.dirname(dir);
    }
  } catch {
    // Package metadata lookup is best-effort; a detached runner must not fail here.
  }
  return undefined;
}

/**
 * Resolve the config directory name from explicit inputs.
 *
 * Pure with respect to its arguments, which is what makes it testable; the
 * process-wide answer comes from `getConfigDirName`.
 */
export function resolveConfigDirName(codingAgentModule?: unknown, entryPoint?: string, packageRoot?: string): string {
  const moduleValue =
    codingAgentModule && typeof codingAgentModule === 'object'
      ? validConfigDirName((codingAgentModule as { CONFIG_DIR_NAME?: unknown }).CONFIG_DIR_NAME)
      : undefined;
  return moduleValue ?? resolveConfigDirNameFromPackageJson(entryPoint, packageRoot) ?? DEFAULT_CONFIG_DIR_NAME;
}

let memoizedConfigDirName: string | undefined;

/** The config directory name for this process. Resolved once, then reused. */
export function getConfigDirName(): string {
  memoizedConfigDirName ??= resolveConfigDirName();
  return memoizedConfigDirName;
}

/**
 * Drop the memoized name.
 *
 * The installation cannot change under a running process, so this exists for
 * tests that vary the environment between cases.
 */
export function resetConfigDirNameCache(): void {
  memoizedConfigDirName = undefined;
}

/** The project-local config directory, for example `<projectRoot>/.pi`. */
export function getProjectConfigDir(projectRoot: string): string {
  return path.join(projectRoot, getConfigDirName());
}

/** Read a JSON settings file as an object, retaining strict path-specific errors. */
export function readSettingsFileStrict(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read settings file '${filePath}': ${message}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse settings file '${filePath}': ${message}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Settings file '${filePath}' must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/** The user-level agent directory, honouring `~` expansion in the override. */
export function getAgentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === HOME_ALIAS) return os.homedir();
  if (configured?.startsWith(HOME_ALIAS_PREFIX)) {
    return path.join(os.homedir(), configured.slice(HOME_ALIAS_PREFIX.length));
  }
  return configured || path.join(os.homedir(), getConfigDirName(), AGENT_DIR_NAME);
}

/** Resolve a child's working directory, which may be relative to the parent's. */
export function resolveChildCwd(baseCwd: string, childCwd: string | undefined): string {
  if (!childCwd) return baseCwd;
  return path.isAbsolute(childCwd) ? childCwd : path.resolve(baseCwd, childCwd);
}
