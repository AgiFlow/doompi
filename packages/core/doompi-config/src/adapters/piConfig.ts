import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PiConfig, PiConfigLoadOptions, PiConfigPaths } from '../schemas/config/schema.ts';
import {
  applyPiImageSettings,
  parsePiImageSettings,
  type PiImageSettings,
  type PiImageSettingsUpdate,
} from '../services/imageSettings.ts';
import { writePrivateAtomicJson } from './atomicJson.ts';

const SETTINGS_FILE_NAME = 'settings.json';
const CONFIG_DIR_NAME = '.pi';
const AGENT_DIR_NAME = 'agent';
const PI_CODING_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';
const LEGACY_CONFIG_DIR_NAME = 'pi';

function defaultAgentDirectory(homeDirectory: string): string {
  const fallback = path.join(homeDirectory, CONFIG_DIR_NAME, AGENT_DIR_NAME);
  if (homeDirectory !== os.homedir()) return fallback;
  const configured = process.env[PI_CODING_AGENT_DIR_ENV]?.trim();
  if (!configured) return fallback;
  if (configured === '~') return homeDirectory;
  if (configured.startsWith('~/')) return path.join(homeDirectory, configured.slice(2));
  return path.resolve(configured);
}
function isObject(value: unknown): value is PiConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeConfig(base: PiConfig, override: PiConfig): PiConfig {
  const result: PiConfig = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] = isObject(current) && isObject(value) ? mergeConfig(current, value) : value;
  }
  return result;
}

function readConfig(filePath: string): PiConfig {
  if (!fs.existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Could not parse Pi settings at ${filePath}`, { cause: error });
  }
  if (!isObject(parsed)) throw new Error(`Pi settings at ${filePath} must be a JSON object`);
  return parsed;
}

async function readConfigAsync(filePath: string): Promise<PiConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Could not parse Pi settings at ${filePath}`, { cause: error });
  }
  if (!isObject(parsed)) throw new Error(`Pi settings at ${filePath} must be a JSON object`);
  return parsed;
}

function readConfigPaths(paths: readonly string[]): PiConfig {
  return paths.reduce<PiConfig>((config, filePath) => mergeConfig(config, readConfig(filePath)), {});
}

async function readConfigPathsAsync(paths: readonly string[]): Promise<PiConfig> {
  const layers = await Promise.all(paths.map(readConfigAsync));
  return layers.reduce<PiConfig>(mergeConfig, {});
}

function projectIsTrusted(value: PiConfigLoadOptions['isProjectTrusted']): boolean {
  return typeof value === 'function' ? value() : value;
}

export function piConfigPaths(
  repoRoot: string,
  homeDirectory = os.homedir(),
  agentDirectory = defaultAgentDirectory(homeDirectory),
): PiConfigPaths {
  return {
    canonicalUser: path.join(agentDirectory, SETTINGS_FILE_NAME),
    canonicalProject: path.join(repoRoot, CONFIG_DIR_NAME, SETTINGS_FILE_NAME),
    legacyUser: [path.join(homeDirectory, CONFIG_DIR_NAME, SETTINGS_FILE_NAME)],
    legacyProject: [path.join(repoRoot, LEGACY_CONFIG_DIR_NAME, SETTINGS_FILE_NAME)],
  };
}

export function loadPiConfig(options: PiConfigLoadOptions): PiConfig {
  const paths = piConfigPaths(options.repoRoot, options.homeDirectory);
  const userPaths = [...paths.legacyUser, ...(options.userConfigPaths ?? []), paths.canonicalUser];
  const projectPaths = [...paths.legacyProject, ...(options.projectConfigPaths ?? []), paths.canonicalProject];
  const defaults = options.defaults ?? {};
  const user = readConfigPaths(userPaths);
  const trustedProject = projectIsTrusted(options.isProjectTrusted) ? readConfigPaths(projectPaths) : {};
  return [
    defaults,
    user,
    options.overlay ?? {},
    trustedProject,
    options.environment ?? {},
    options.cli ?? {},
    options.programmatic ?? {},
  ].reduce(mergeConfig, {});
}

export async function loadPiConfigAsync(options: PiConfigLoadOptions): Promise<PiConfig> {
  const paths = piConfigPaths(options.repoRoot, options.homeDirectory);
  const userPaths = [...paths.legacyUser, ...(options.userConfigPaths ?? []), paths.canonicalUser];
  const projectPaths = [...paths.legacyProject, ...(options.projectConfigPaths ?? []), paths.canonicalProject];
  const [user, trustedProject] = await Promise.all([
    readConfigPathsAsync(userPaths),
    projectIsTrusted(options.isProjectTrusted) ? readConfigPathsAsync(projectPaths) : Promise.resolve({}),
  ]);
  return [
    options.defaults ?? {},
    user,
    options.overlay ?? {},
    trustedProject,
    options.environment ?? {},
    options.cli ?? {},
    options.programmatic ?? {},
  ].reduce(mergeConfig, {});
}

/**
 * Where the image limits are read from and written to.
 *
 * The user layer only. Pi merges a trusted project settings.json over it, but
 * these limits describe one machine's tolerance for image payloads rather than
 * one repository's, and the cockpit page that writes them has no repository
 * scope to offer. The legacy user path is still read, because a machine that
 * has not been migrated still answers from it.
 */
function userSettingsPaths(homeDirectory: string): { legacy: string; canonical: string } {
  return {
    legacy: path.join(homeDirectory, CONFIG_DIR_NAME, SETTINGS_FILE_NAME),
    canonical: path.join(defaultAgentDirectory(homeDirectory), SETTINGS_FILE_NAME),
  };
}

/** The file a change lands in; Pi's own settings toggle writes the same one. */
export function piImageSettingsPath(homeDirectory = os.homedir()): string {
  return userSettingsPaths(homeDirectory).canonical;
}

export function loadPiImageSettings(homeDirectory = os.homedir()): PiImageSettings {
  const paths = userSettingsPaths(homeDirectory);
  return parsePiImageSettings(readConfigPaths([paths.legacy, paths.canonical]));
}

/**
 * Writes the changed keys back and reports the limits that now apply.
 *
 * Read-modify-write on Pi's own file, so a save races a concurrent Pi settings
 * save rather than merging with it. Pi writes only the fields its UI touched,
 * as this does, which keeps the window to the one setting being changed on
 * both sides at once.
 */
export function savePiImageSettings(update: PiImageSettingsUpdate, homeDirectory = os.homedir()): PiImageSettings {
  const paths = userSettingsPaths(homeDirectory);
  writePrivateAtomicJson(paths.canonical, applyPiImageSettings(readConfig(paths.canonical), update));
  return loadPiImageSettings(homeDirectory);
}
