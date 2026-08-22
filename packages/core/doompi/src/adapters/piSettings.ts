import os from 'node:os';
import path from 'node:path';
import { isRecord, readJson, writeFileAtomic } from './serialization/json';
import type { JsonObject } from './serialization/json';
import { DOOM_PACKAGE_NAME } from './doomPackage.ts';

/**
 * Pi's user settings, as `doompi sync` maintains them.
 *
 * The Doom package is registered globally so a plain `pi` process can find the
 * lightweight package bootstrap before project resources are trusted. Sync owns
 * the extension registration, ambient-discovery filter, theme resource, selected default theme, and quiet-startup keys
 * while preserving every unrelated user setting.
 */

const PI_CODING_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';
const PI_DIRECTORY = '.pi';
const AGENT_DIRECTORY = 'agent';
const SETTINGS_FILE = 'settings.json';
const THEMES_DIRECTORY = 'themes';
const EXTENSIONS_KEY = 'extensions';
const THEMES_KEY = 'themes';
const THEME_KEY = 'theme';
const QUIET_STARTUP_KEY = 'quietStartup';
const HOME_ALIAS = '~';
const HOME_ALIAS_PREFIX = '~/';
/** The stable package entry Pi loads for every synced repository. */
export const DOOM_EXTENSION = DOOM_PACKAGE_NAME;
/** Suppresses Pi's ambient extension-directory scan while leaving explicit sources intact. */
export const AMBIENT_EXTENSION_FILTER = '!extensions/**';
export interface PiSettingsUpdate {
  /** Absolute path to the synchronized user theme file. */
  themePath: string;
  themeName: string;
}

/** Pi's user configuration directory, honoring its documented override. */
export function piAgentDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): string {
  const configured = environment[PI_CODING_AGENT_DIR_ENV]?.trim();
  if (!configured) return path.join(homeDirectory, PI_DIRECTORY, AGENT_DIRECTORY);
  if (configured === HOME_ALIAS) return homeDirectory;
  if (configured.startsWith(HOME_ALIAS_PREFIX)) {
    return path.join(homeDirectory, configured.slice(HOME_ALIAS_PREFIX.length));
  }
  return path.resolve(configured);
}

export function piSettingsPath(agentDirectory: string): string {
  return path.join(agentDirectory, SETTINGS_FILE);
}

export function piThemeDirectory(agentDirectory: string): string {
  return path.join(agentDirectory, THEMES_DIRECTORY);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function settingsRelativePath(agentDirectory: string, target: string): string {
  const relative = path.relative(agentDirectory, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return target;
  return relative.split(path.sep).join('/');
}

function isManagedExtension(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return normalized === DOOM_EXTENSION || normalized === AMBIENT_EXTENSION_FILTER;
}

function isLegacyDoomTheme(value: string, themeName: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return normalized.endsWith(`/doom/${themeName}.json`) || normalized === `doom/${themeName}.json`;
}

/** Produces the user settings content for an update, without writing it. */
export function mergePiSettings(current: JsonObject, agentDirectory: string, update: PiSettingsUpdate): JsonObject {
  const theme = settingsRelativePath(agentDirectory, update.themePath);
  // First in the list, so the harness environment is hydrated before any
  // extension a user added themselves runs. The filter affects only Pi's
  // automatic extensions/** scan; explicit settings and CLI entries still load.
  const extensions = [
    DOOM_EXTENSION,
    AMBIENT_EXTENSION_FILTER,
    ...stringList(current[EXTENSIONS_KEY]).filter((value) => !isManagedExtension(value)),
  ];
  const themes = [
    theme,
    ...stringList(current[THEMES_KEY]).filter(
      (value) => value !== theme && !isLegacyDoomTheme(value, update.themeName),
    ),
  ];
  return {
    ...current,
    [QUIET_STARTUP_KEY]: true,
    [EXTENSIONS_KEY]: extensions,
    [THEMES_KEY]: themes,
    // Only filled in when unset: a theme the user picked later is their choice,
    // and re-imposing the Doom theme on every sync would silently undo it.
    [THEME_KEY]: typeof current[THEME_KEY] === 'string' ? current[THEME_KEY] : update.themeName,
  };
}

export function readPiSettings(agentDirectory: string): JsonObject {
  const settings = readJson(piSettingsPath(agentDirectory));
  return isRecord(settings) ? settings : {};
}

export function serializePiSettings(settings: JsonObject): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** Merges the Doom-owned keys into Pi's user settings file. */
export function writePiSettings(agentDirectory: string, update: PiSettingsUpdate): string {
  const settingsPath = piSettingsPath(agentDirectory);
  writeFileAtomic(
    settingsPath,
    serializePiSettings(mergePiSettings(readPiSettings(agentDirectory), agentDirectory, update)),
  );
  return settingsPath;
}
