/**
 * Locating the project root that agent configuration hangs off.
 *
 * A project root is any ancestor of the working directory that carries a config
 * directory or a legacy `.agents` directory. There can be several: a package
 * inside a monorepo and the monorepo itself both qualify. Which one wins is a
 * setting, because both answers are legitimate. Teams that keep one shared set
 * of agents at the repository root want `git-root`, teams that give each package
 * its own want `nearest`, and neither can be inferred from the tree alone.
 *
 * DESIGN PATTERNS:
 * - Candidates are collected once, nearest first, then a policy picks from them.
 *   Separating collection from policy is what lets `git-root` be answered
 *   without a second walk
 * - Path derivation goes through `shared/configDir.ts`, so a rebranded build
 *   that renames its config directory needs no change here
 *
 * AVOID:
 * - Hardcoding the config directory name; it is discovered, not assumed
 * - Treating the nearest candidate as the project root without reading the
 *   setting first
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getAgentDir, getProjectConfigDir, readSettingsFileStrict } from '../filesystem/configDir';

const SETTINGS_FILE_NAME = 'settings.json';
const GIT_DIR_NAME = '.git';
/**
 * Bare `.agents`. Two roles, one name: under a project root it is the legacy
 * location that predates the config directory, under the home directory it is
 * the current one. Both are read.
 */
const DOT_AGENTS_DIR_NAME = '.agents';
/** Agents inside a config directory, project-level or user-level. */
const AGENTS_DIR_NAME = 'agents';
const SUBAGENTS_SETTINGS_KEY = 'subagents';
const PROJECT_ROOT_RESOLUTION_KEY = 'projectRootResolution';

/**
 * Which candidate root wins when several ancestors qualify.
 *
 * `nearest` stops at the first one found walking up; `git-root` prefers the
 * candidate that is also the enclosing git repository root.
 */
export type ProjectRootResolution = 'nearest' | 'git-root';

/** Stable cache identity for equivalent absolute, relative, and symlinked cwd spellings. */
export function canonicalizeDiscoveryCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    // Missing or inaccessible paths still need a deterministic cache identity.
    return resolved;
  }
}

/** Whether a path exists and is a directory. Any failure reads as "no". */
export function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    // A missing path, a broken symlink, or a permission error all mean "not usable".
    return false;
  }
}

/** True when `dir` carries either marker that makes it a project root. */
export function isProjectRootCandidate(dir: string): boolean {
  return isDirectory(getProjectConfigDir(dir)) || isDirectory(path.join(dir, DOT_AGENTS_DIR_NAME));
}

/** Every project root above `cwd`, nearest first. */
export function findProjectRootCandidates(cwd: string): string[] {
  const roots: string[] = [];
  let currentDir = cwd;
  while (true) {
    if (isProjectRootCandidate(currentDir)) roots.push(currentDir);

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return roots;
    currentDir = parentDir;
  }
}

/**
 * Nearest ancestor containing `.git`.
 *
 * Existence is enough: a worktree or submodule has a `.git` file rather than a
 * directory, and both are real repository roots.
 */
export function findNearestGitRoot(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    if (fs.existsSync(path.join(currentDir, GIT_DIR_NAME))) return currentDir;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

/**
 * Read a candidate's declared resolution policy.
 *
 * Deliberately throws on an unrecognised value rather than falling back: a typo
 * here silently changes which agents the whole session sees.
 */
export function readProjectRootResolution(projectRoot: string): ProjectRootResolution | undefined {
  const settingsPath = path.join(getProjectConfigDir(projectRoot), SETTINGS_FILE_NAME);
  if (!fs.existsSync(settingsPath)) return undefined;

  const settings = readSettingsFileStrict(settingsPath);
  const subagents = settings[SUBAGENTS_SETTINGS_KEY];
  if (!subagents || typeof subagents !== 'object' || Array.isArray(subagents)) return undefined;

  const value = (subagents as Record<string, unknown>)[PROJECT_ROOT_RESOLUTION_KEY];
  if (value === undefined) return undefined;
  if (value === 'nearest' || value === 'git-root') return value;
  throw new Error(
    `Subagent settings in '${settingsPath}' have invalid '${PROJECT_ROOT_RESOLUTION_KEY}'; expected 'nearest' or 'git-root'.`,
  );
}

/** The closest project root above `cwd`, ignoring any resolution policy. */
export function findNearestProjectRoot(cwd: string): string | null {
  return findProjectRootCandidates(cwd)[0] ?? null;
}

/**
 * The project root to use, honouring the resolution policy.
 *
 * The policy is read from the nearest candidate first so a package can opt out
 * of its monorepo's shared agents, and from the git root second so a repository
 * can claim its packages without editing each one.
 */
export function findConfiguredProjectRoot(cwd: string): string | null {
  const candidates = findProjectRootCandidates(cwd);
  const nearestRoot = candidates[0];
  if (!nearestRoot) return null;

  const nearestMode = readProjectRootResolution(nearestRoot);
  if (nearestMode === 'nearest') return nearestRoot;

  const gitRoot = findNearestGitRoot(cwd);
  const gitProjectRoot = gitRoot
    ? candidates.find((candidate) => path.resolve(candidate) === path.resolve(gitRoot))
    : undefined;
  if (gitProjectRoot && (nearestMode === 'git-root' || readProjectRootResolution(gitProjectRoot) === 'git-root')) {
    return gitProjectRoot;
  }

  return nearestRoot;
}

/**
 * User-level agent directories, in load order.
 *
 * Two locations, not one: agents used to live in the config directory and now
 * also live in `~/.agents`, and both are still read so an existing setup keeps
 * working after the move. Returned unfiltered because the caller reads each
 * directory anyway and a missing one costs nothing.
 */
export function userAgentDirs(): string[] {
  return [path.join(getAgentDir(), AGENTS_DIR_NAME), path.join(os.homedir(), DOT_AGENTS_DIR_NAME)];
}

/** The user-level settings file. Always resolvable, unlike the project one. */
export function getUserAgentSettingsPath(): string {
  return path.join(getAgentDir(), SETTINGS_FILE_NAME);
}

/** The project settings file, or null when `cwd` sits under no project root. */
export function getProjectAgentSettingsPath(cwd: string): string | null {
  const projectRoot = findConfiguredProjectRoot(cwd);
  return projectRoot ? path.join(getProjectConfigDir(projectRoot), SETTINGS_FILE_NAME) : null;
}

/**
 * Project agent directories for `cwd`.
 *
 * `readDirs` holds only directories that exist, so discovery never stats twice,
 * and lists the legacy location first so a project mid-migration still resolves.
 * `preferredDir` is where a newly created agent should be written, and is
 * returned whether or not it exists yet.
 */
export function resolveNearestProjectAgentDirs(cwd: string): { readDirs: string[]; preferredDir: string | null } {
  const projectRoot = findConfiguredProjectRoot(cwd);
  if (!projectRoot) return { readDirs: [], preferredDir: null };

  const legacyDir = path.join(projectRoot, DOT_AGENTS_DIR_NAME);
  const preferredDir = path.join(getProjectConfigDir(projectRoot), AGENTS_DIR_NAME);
  const readDirs: string[] = [];
  if (isDirectory(legacyDir)) readDirs.push(legacyDir);
  if (isDirectory(preferredDir)) readDirs.push(preferredDir);

  return { readDirs, preferredDir };
}
