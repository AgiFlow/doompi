import fs from 'node:fs';
import path from 'node:path';

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
export async function listDirectories(typed: string, limit = DEFAULT_LIMIT): Promise<string[]> {
  const query = splitDirectoryQuery(typed);
  if (query === undefined) return [];
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
