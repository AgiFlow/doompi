import fs from 'node:fs';
import path from 'node:path';

/**
 * Recognizing an installed DoomPi package on disk.
 *
 * Pi resolves settings entries to paths rather than through Node, so the same
 * package is spelled differently in every scope: a bare name beside the user
 * config, a relative directory beside the project config, a file inside either.
 * Both the extension alias and the project settings reconciler have to decide
 * whether one of those spellings names this package, and they have to agree.
 */

const PACKAGE_MANIFEST = 'package.json';

/** The package name Pi loads DoomPi under, in every settings scope. */
export const DOOM_PACKAGE_NAME = '@agimon-ai/doompi';

/** The `name` field of the manifest in a directory, when it has a readable one. */
export function manifestName(directory: string): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, PACKAGE_MANIFEST), 'utf8')) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name : undefined;
  } catch {
    // A directory with no readable manifest simply is not a package root.
    return undefined;
  }
}

/**
 * Name of the nearest package a path belongs to, walking upward from it.
 *
 * The first manifest found wins rather than the first matching one, so a file
 * inside some other package nested under a DoomPi checkout is not mistaken for
 * DoomPi itself.
 */
export function enclosingPackageName(target: string): string | undefined {
  let directory: string;
  try {
    directory = fs.statSync(target).isDirectory() ? target : path.dirname(target);
  } catch {
    // Nothing at that path, so it names no package.
    return undefined;
  }

  while (true) {
    const name = manifestName(directory);
    if (name !== undefined) return name;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** True when a resolved path lives inside an installed DoomPi package. */
export function isDoomPackagePath(target: string): boolean {
  return enclosingPackageName(target) === DOOM_PACKAGE_NAME;
}
