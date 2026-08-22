import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isRecord, readJson, writeFileAtomic } from './serialization/json';
import type { JsonObject } from './serialization/json';
import { DOOM_PACKAGE_NAME, isDoomPackagePath } from './doomPackage.ts';
import { piExtensionAliasPath } from './piExtensionAlias.ts';

/**
 * Pi's project settings, as `doompi sync` reconciles them.
 *
 * Pi documents project settings as overriding user settings, but resource
 * resolution unions the two scopes and dedupes only by the resolved file's real
 * path. A repository that registers DoomPi alongside the stable user entry
 * therefore loads two installs of the same package against one home-scoped
 * worktree state. Sync removes the redundant project registration and leaves every
 * other key alone: the repository still overrides the user scope, through its own
 * `.doom` configuration and the runtime staged under `~/.pi/.doom/sync`.
 */

const PI_DIRECTORY = '.pi';
const SETTINGS_FILE = 'settings.json';
const EXTENSIONS_KEY = 'extensions';
const PACKAGES_KEY = 'packages';
const PACKAGE_SOURCE_KEY = 'source';
const HOME_ALIAS = '~';
const HOME_ALIAS_PREFIX = '~/';
/** Pattern-form entries Pi filters with rather than resolves. */
const PATTERN_PREFIXES = ['!', '+', '-'] as const;

/**
 * Reported by `sync --check` and `build`, and repaired by `sync`.
 *
 * Lives here rather than with either command because both report the same
 * finding about the same file, and the detector below is what decides it.
 */
export const DUPLICATE_REGISTRATION_DRIFT = 'duplicate DoomPi registration in .pi/settings.json';

/** Pi's project configuration directory, the base its relative paths resolve against. */
export function projectPiDirectory(repoRoot: string): string {
  return path.join(repoRoot, PI_DIRECTORY);
}

export function projectPiSettingsPath(repoRoot: string): string {
  return path.join(projectPiDirectory(repoRoot), SETTINGS_FILE);
}

function resolveSettingsPath(value: string, baseDirectory: string, homeDirectory: string): string {
  if (value === HOME_ALIAS) return homeDirectory;
  if (value.startsWith(HOME_ALIAS_PREFIX)) return path.join(homeDirectory, value.slice(HOME_ALIAS_PREFIX.length));
  return path.resolve(baseDirectory, value);
}

/**
 * Whether one settings entry names this package.
 *
 * The bare package name is matched textually because that is the spelling sync
 * writes into the user scope, and a resolved path is matched by walking to the
 * package it belongs to, which is what catches `../packages/core/doompi` and a
 * direct reference to a file inside it. Pattern entries select among already
 * resolved paths rather than naming one, so they are left for the user to own.
 */
function isDoomEntry(value: string, baseDirectory: string, homeDirectory: string): boolean {
  const normalized = value.replaceAll('\\', '/').trim();
  if (normalized === DOOM_PACKAGE_NAME) return true;
  if (PATTERN_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  return isDoomPackagePath(resolveSettingsPath(normalized, baseDirectory, homeDirectory));
}

function packageSource(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (isRecord(entry) && typeof entry[PACKAGE_SOURCE_KEY] === 'string') return entry[PACKAGE_SOURCE_KEY];
  return undefined;
}

/**
 * Drops DoomPi from one resource list, or reports that the key should go.
 *
 * A list that empties out is removed rather than left behind: an empty array is
 * indistinguishable from an absent one to Pi, and keeping it would leave the
 * repository looking like it still configures something.
 */
function withoutDoomEntries(value: unknown, baseDirectory: string, homeDirectory: string): unknown {
  if (!Array.isArray(value)) return value;
  const kept = value.filter((entry) => {
    const source = packageSource(entry);
    return source === undefined || !isDoomEntry(source, baseDirectory, homeDirectory);
  });
  if (kept.length === value.length) return value;
  return kept.length > 0 ? kept : undefined;
}

/** Produces the project settings content for a reconciliation, without writing it. */
export function mergeProjectPiSettings(
  current: JsonObject,
  repoRoot: string,
  homeDirectory: string = os.homedir(),
): JsonObject {
  const baseDirectory = projectPiDirectory(repoRoot);
  const merged: JsonObject = { ...current };
  for (const key of [EXTENSIONS_KEY, PACKAGES_KEY]) {
    if (!(key in merged)) continue;
    const next = withoutDoomEntries(merged[key], baseDirectory, homeDirectory);
    if (next === undefined) delete merged[key];
    else merged[key] = next;
  }
  return merged;
}

/** Reads Pi's project settings, or nothing when the repository declares none. */
export function readProjectPiSettings(repoRoot: string): JsonObject | undefined {
  const settingsPath = projectPiSettingsPath(repoRoot);
  if (!fs.existsSync(settingsPath)) return undefined;
  const settings = readJson(settingsPath);
  return isRecord(settings) ? settings : {};
}

export function serializeProjectPiSettings(settings: JsonObject): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** True when the repository still registers DoomPi alongside the user scope. */
export function projectRegistersDoom(repoRoot: string, homeDirectory: string = os.homedir()): boolean {
  const settings = readProjectPiSettings(repoRoot);
  if (!settings) return false;
  return (
    serializeProjectPiSettings(mergeProjectPiSettings(settings, repoRoot, homeDirectory)) !==
    serializeProjectPiSettings(settings)
  );
}

/**
 * Removes the alias a repository-scoped registration needed.
 *
 * Only a symbolic link is removed, for the same reason sync refuses to replace
 * one: anything else at that path was not created here.
 */
function removeProjectExtensionAlias(repoRoot: string): void {
  const aliasPath = piExtensionAliasPath(projectPiDirectory(repoRoot));
  if (fs.lstatSync(aliasPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
    fs.rmSync(aliasPath, { force: true });
  }
}

/**
 * Reconciles the repository's Pi settings with the user-scope registration.
 *
 * The file is never created and never deleted, only rewritten: an absent one
 * means the repository registers nothing, and an existing one is a repository
 * root marker that other DoomPi code walks up to find.
 */
export function writeProjectPiSettings(repoRoot: string, homeDirectory: string = os.homedir()): string | undefined {
  const settings = readProjectPiSettings(repoRoot);
  removeProjectExtensionAlias(repoRoot);
  if (!settings) return undefined;

  const merged = mergeProjectPiSettings(settings, repoRoot, homeDirectory);
  const serialized = serializeProjectPiSettings(merged);
  if (serialized === serializeProjectPiSettings(settings)) return undefined;

  const settingsPath = projectPiSettingsPath(repoRoot);
  writeFileAtomic(settingsPath, serialized);
  return settingsPath;
}
