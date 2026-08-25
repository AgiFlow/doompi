import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** How deep a search descends; a project someone starts a session in is never far from home. */
const MAX_DEPTH = 6;
/** A ceiling on the walk so a pathological tree cannot hold the request open. */
const MAX_VISITED = 20_000;
/** `fd` is fast; if it has not answered by now the fallback will beat waiting for it. */
const FD_TIMEOUT_MS = 1_500;
const FD_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Directories nobody starts a session in, and which dwarf everything else in
 * a tree. Pruning them is the difference between a walk that answers now and
 * one that reads a million files.
 */
const PRUNED = new Set([
  'node_modules',
  'Library',
  'Applications',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'coverage',
  '.git',
  '.nx',
  '.next',
  '.cache',
  '.venv',
  '__pycache__',
]);

const HIDDEN_PREFIX = '.';

function skips(name: string, wantsHidden: boolean): boolean {
  if (PRUNED.has(name)) return true;
  return name.startsWith(HIDDEN_PREFIX) && !wantsHidden;
}

/**
 * `fd` if this machine has it: it is built for exactly this, prunes ignored
 * paths itself, and is far quicker than walking from Node. A missing binary,
 * a non-zero exit, or a slow answer all fall through to the walk rather than
 * failing the request, because a suggestion list is a convenience.
 */
async function searchWithFd(root: string, query: string, wantsHidden: boolean): Promise<string[] | undefined> {
  const args = [
    '--type',
    'd',
    '--absolute-path',
    '--fixed-strings',
    '--color',
    'never',
    '--max-depth',
    String(MAX_DEPTH),
    // The same prune list the walk uses, so which engine answered is invisible
    // to the reader: no caches, no build output, no OS folders nobody codes in.
    ...[...PRUNED].flatMap((name) => ['--exclude', name]),
    ...(wantsHidden ? ['--hidden'] : []),
    '--',
    query,
    root,
  ];
  return new Promise((resolve) => {
    execFile('fd', args, { timeout: FD_TIMEOUT_MS, maxBuffer: FD_MAX_BUFFER }, (error, stdout) => {
      // fd exits non-zero when it matches nothing, which is an answer, not a
      // failure; only a missing binary or a timeout sends us to the walk.
      if (error && stdout.length === 0 && error.code !== 1) {
        resolve(undefined);
        return;
      }
      resolve(
        stdout
          .split('\n')
          .map((line) => line.trimEnd().replace(/\/$/u, ''))
          .filter((line) => line !== ''),
      );
    });
  });
}

/** Every directory under a root, breadth first, bounded in depth and in total work. */
async function walkDirectories(root: string, wantsHidden: boolean): Promise<string[]> {
  const found: string[] = [];
  let frontier = [root];
  let visited = 0;

  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0 && visited < MAX_VISITED; depth += 1) {
    const next: string[] = [];
    for (const directory of frontier) {
      if (visited >= MAX_VISITED) break;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch {
        continue; // Unreadable is not an error here, just nothing to offer.
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || skips(entry.name, wantsHidden)) continue;
        visited += 1;
        const child = path.join(directory, entry.name);
        found.push(child);
        next.push(child);
      }
    }
    frontier = next;
  }
  return found;
}

/**
 * Directories under a root whose path could answer the query.
 *
 * Matching happens in the caller, against the whole candidate set, so the
 * ranking is the same whichever engine produced it.
 */
export async function searchDirectoryTree(root: string, query: string): Promise<string[]> {
  const wantsHidden = query.startsWith(HIDDEN_PREFIX);
  const viaFd = await searchWithFd(root, query, wantsHidden);
  return viaFd ?? (await walkDirectories(root, wantsHidden));
}
