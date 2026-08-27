import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { TreeManifest, TreeManifestPort } from '../../types/treeManifest.ts';

/**
 * Take a bounded manifest of a working tree and report which files moved
 * between two of them.
 *
 * One technology per adapter. This is where node enters the package; the
 * services that depend on the capability keep importing the port.
 *
 * The caps are the whole design. An unbounded walk of a working directory is
 * dominated by dependency and build trees, which change constantly and tell a
 * reader nothing, so those are skipped by name; what remains is capped on both
 * entries and depth so the walk stays a fixed cost rather than a function of
 * how large the checkout grew. Hitting a cap is reported, never hidden.
 */

/** Directories a working tree fills with output nobody wants listed as an edit. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.gradle',
  '.next',
  '.nuxt',
  '.nx',
  '.pnpm-store',
  '.turbo',
  '.venv',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
  'venv',
]);

export const MAX_ENTRIES = 20_000;
export const MAX_DEPTH = 12;

/**
 * How a file is summarised. Size and modification time are what a walk can read
 * cheaply for thousands of files; hashing every one of them would turn a scan
 * into a read of the whole tree.
 */
function fingerprintOf(size: number, modifiedMs: number): string {
  return `${size}:${modifiedMs}`;
}

export interface NodeTreeManifestOptions {
  maxEntries?: number;
  maxDepth?: number;
  ignoredDirectories?: ReadonlySet<string>;
}

export class NodeTreeManifestAdapter implements TreeManifestPort {
  private readonly maxEntries: number;
  private readonly maxDepth: number;
  private readonly ignored: ReadonlySet<string>;

  constructor(options: NodeTreeManifestOptions = {}) {
    this.maxEntries = options.maxEntries ?? MAX_ENTRIES;
    this.maxDepth = options.maxDepth ?? MAX_DEPTH;
    this.ignored = options.ignoredDirectories ?? IGNORED_DIRECTORIES;
  }

  async take(root: string, exclude: readonly string[] = []): Promise<TreeManifest> {
    const entries = new Map<string, string>();
    const skipped = new Set(exclude.map((entry) => path.resolve(entry)));
    const truncated = await this.walk(root, 0, entries, skipped);
    return { entries, truncated };
  }

  async fingerprint(filePath: string): Promise<string | undefined> {
    try {
      const stat = await fs.stat(filePath);
      return stat.isFile() ? fingerprintOf(stat.size, stat.mtimeMs) : undefined;
    } catch {
      return undefined;
    }
  }

  changed(before: TreeManifest, after: TreeManifest): string[] {
    const moved = new Set<string>();
    for (const [filePath, fingerprint] of after.entries) {
      if (before.entries.get(filePath) !== fingerprint) moved.add(filePath);
    }
    for (const filePath of before.entries.keys()) {
      if (!after.entries.has(filePath)) moved.add(filePath);
    }
    return [...moved].sort();
  }

  /** Fills `entries` depth-first and answers whether a cap cut the walk short. */
  private async walk(
    directory: string,
    depth: number,
    entries: Map<string, string>,
    skipped: ReadonlySet<string>,
  ): Promise<boolean> {
    if (depth > this.maxDepth) return true;
    let listing: Dirent[];
    try {
      listing = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      // A directory that vanished or refused a read is not the walk's problem;
      // the rest of the tree is still worth reporting.
      return false;
    }
    let truncated = false;
    for (const entry of listing) {
      if (entries.size >= this.maxEntries) return true;
      const entryPath = path.join(directory, entry.name);
      if (skipped.has(entryPath)) continue;
      // Symlinks are never followed: a link into a parent turns the walk into a
      // cycle, and a link out of the tree reports a file this session does not own.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (this.ignored.has(entry.name)) continue;
        truncated = (await this.walk(entryPath, depth + 1, entries, skipped)) || truncated;
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.stat(entryPath);
        entries.set(entryPath, fingerprintOf(stat.size, stat.mtimeMs));
      } catch {
        // Raced with a delete between readdir and stat; it is simply not there.
      }
    }
    return truncated;
  }
}
