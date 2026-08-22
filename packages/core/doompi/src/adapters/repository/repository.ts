import fs from 'node:fs';
import path from 'node:path';

/** Doom's own repository configuration directory. */
const DOOM_DIRECTORY = '.doom';
/** Git's root marker, which may be a directory or a worktree pointer file. */
const GIT_DIRECTORY = '.git';
/** A Pi project that has been configured, rather than any stray `.pi` folder. */
const PI_SETTINGS = path.join('.pi', 'settings.json');

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * True when a directory carries a marker Doom Pi is willing to treat as a root.
 *
 * Doom and Pi markers identify configured projects. A Git marker also counts so
 * personal configuration can be synchronized into a new checkout before it has
 * repository-local configuration. Build-tooling markers remain deliberately
 * excluded because they do not establish a repository boundary.
 */
export function isRepositoryRoot(directory: string): boolean {
  const gitMarker = path.join(directory, GIT_DIRECTORY);
  return (
    isDirectory(path.join(directory, DOOM_DIRECTORY)) ||
    isFile(path.join(directory, PI_SETTINGS)) ||
    isDirectory(gitMarker) ||
    isFile(gitMarker)
  );
}

/**
 * Walks up from `start` looking for the repository root.
 *
 * The nearest marked ancestor wins, so a session started in a subdirectory
 * resolves to the repository that configured Doom rather than to a parent
 * checkout that happens to sit above it.
 */
export function findRepositoryRoot(start: string): string {
  let directory = path.resolve(start);
  while (true) {
    if (isRepositoryRoot(directory)) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Could not find repository root from ${start}`);
    directory = parent;
  }
}
