import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rankDirectories, searchTermFor } from '../services/directoryMatch.ts';
import { isInsideDirectory } from '../services/pathScope.ts';
import { searchDirectoryTree } from './directorySearch.ts';

const PATH_SEPARATOR = '/';
const HIDDEN_PREFIX = '.';
/** A pattern that starts with a dot, literal or escaped, anchored or not, is asking for dotdirs. */
const ASKS_FOR_HIDDEN = /^\^?\\?\./;
/** The picker shows a handful; a longer list is a sign to type more. */
const DEFAULT_LIMIT = 12;

export interface DirectoryQuery {
  /** The directory whose children are listed. */
  parent: string;
  /** The typed trailing segment, applied to child names as a regular expression. */
  pattern: string;
}

/**
 * Splits a typed path into the directory to list and the filter for its
 * children: everything up to the last slash is the parent, the rest is the
 * pattern. Only absolute paths qualify, matching what a session accepts.
 */
export function splitDirectoryQuery(typed: string): DirectoryQuery | undefined {
  if (!path.isAbsolute(typed)) return undefined;
  const cut = typed.lastIndexOf(PATH_SEPARATOR);
  return { parent: cut === 0 ? PATH_SEPARATOR : typed.slice(0, cut), pattern: typed.slice(cut + 1) };
}

function nameMatcher(pattern: string): (name: string) => boolean {
  if (pattern === '') return () => true;
  try {
    const regex = new RegExp(pattern, 'i');
    return (name) => regex.test(name);
  } catch {
    // A pattern still being typed ("src/[") is not a regex yet; substring
    // matching keeps the list narrowing instead of going blank.
    const lowered = pattern.toLowerCase();
    return (name) => name.toLowerCase().includes(lowered);
  }
}

async function isDirectory(parent: string, entry: fs.Dirent): Promise<boolean> {
  if (!entry.isSymbolicLink()) return entry.isDirectory();
  try {
    return (await fs.promises.stat(path.join(parent, entry.name))).isDirectory();
  } catch {
    return false; // A dangling link is not somewhere a session can start.
  }
}

/**
 * Absolute paths of the directories the typed path could complete to, for
 * the new-session picker. Hidden directories stay out of the way unless the
 * pattern itself begins with a dot; an unreadable or missing parent yields
 * nothing rather than an error, since the person is still typing.
 */
export async function listDirectories(typed: string, limit = DEFAULT_LIMIT, root?: string): Promise<string[]> {
  const query = splitDirectoryQuery(typed);
  if (query === undefined) return [];
  // Checked on the parent rather than each child: a parent outside the scope
  // has no child inside it, and listing it at all would confirm what is there.
  if (root !== undefined && !isInsideDirectory(query.parent, root)) return [];
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(query.parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const showHidden = ASKS_FOR_HIDDEN.test(query.pattern);
  const matches = nameMatcher(query.pattern);
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(HIDDEN_PREFIX) && !showHidden) continue;
    if (!matches(entry.name)) continue;
    if (await isDirectory(query.parent, entry)) names.push(entry.name);
  }
  names.sort((left, right) => left.localeCompare(right));
  return names.slice(0, limit).map((name) => path.join(query.parent, name));
}

/**
 * Where a fuzzy search starts when the typed value names no place that exists.
 *
 * Home is where projects live, and a path outside it is still reachable by
 * typing it out, which is what the completion above is for. A scope replaces
 * home entirely rather than narrowing it, because the point of a scope is that
 * nothing outside it is searched at all.
 */
function searchRoots(homeDirectory: string, root: string | undefined): string[] {
  return [root ?? homeDirectory];
}

export interface SuggestDirectoriesOptions {
  limit?: number;
  /**
   * The only subtree the answer may name.
   *
   * Set while remote access is on and the cockpit is not contained, because a
   * paired device asking for suggestions would otherwise enumerate the host's
   * whole home directory, which is a map of the machine it is not entitled to.
   */
  root?: string;
  /** Injectable so a test does not search the machine it runs on. */
  homeDirectory?: string;
  /** Injectable seam over the tree search. */
  search?: (root: string, query: string) => Promise<string[]>;
}

/**
 * The directories to offer for a typed value, however it was typed.
 *
 * Completion comes first: an absolute path whose parent exists is someone
 * drilling in, and listing that parent's children is exactly right. Anything
 * else is a name, not a location. A bare "agirepo", or a path remembered from
 * another machine where the folder sat somewhere else, both mean the same
 * thing, and answering "No such directory" to either is a dead end when the
 * folder is sitting in the reader's home directory under a different parent.
 */
export async function suggestDirectories(typed: string, options: SuggestDirectoriesOptions = {}): Promise<string[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const completions = await listDirectories(typed, limit, options.root);
  if (completions.length > 0) return completions;

  const query = searchTermFor(typed);
  if (query === '') return [];
  const home = options.homeDirectory ?? os.homedir();
  const search = options.search ?? searchDirectoryTree;

  const found: string[] = [];
  for (const root of searchRoots(home, options.root)) {
    try {
      found.push(...(await search(root, query)));
    } catch {
      // A root that cannot be searched simply contributes nothing.
    }
  }
  const scope = options.root;
  const scoped = scope === undefined ? found : found.filter((entry) => isInsideDirectory(entry, scope));
  return rankDirectories(scoped, query, limit);
}
