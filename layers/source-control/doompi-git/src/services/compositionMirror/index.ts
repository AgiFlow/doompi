/**
 * Giving a new worktree the build output its parent checkout already has.
 *
 * DESIGN PATTERNS:
 * - Mirrors, never builds. Everything here is a copy or a symlink of something
 *   the parent checkout already produced, so it costs seconds and cannot fail
 *   the way a package manager or a compiler can.
 * - `node_modules` is linked, `dist` is copied. The module tree is gigabytes
 *   and read-only in practice, so a link is right; build output is small and a
 *   link would send a build run inside the worktree straight into the parent's
 *   directory.
 * - Absent parent output means nothing to do. A repository with no
 *   `node_modules` at its root is either not a JS project or not installed, and
 *   either way this has no opinion about it, so a Rust, Go or Python worktree
 *   pays nothing.
 *
 * WHY THIS EXISTS:
 * A DoomPi session composes the extensions its repository's config names, and
 * this repository names its own workspace packages by relative path. Those
 * packages declare `pi.extensions` under `dist/`, which git does not track, so
 * a fresh worktree resolves none of them and the session dies on start. The
 * parent checkout has already built exactly what the child needs.
 *
 * AVOID:
 * - Recursing into `node_modules`. The scan is bounded and skips it; without
 *   that this walks a gigabyte to find nothing.
 * - Treating a mirror failure as fatal. The worktree is good either way; only
 *   the session's composition is poorer for it.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Directories that are build output worth copying into a new worktree. */
const OUTPUT_DIRECTORY = 'dist';
const MODULES_DIRECTORY = 'node_modules';
const GIT_DIRECTORY = '.git';
/**
 * How deep the scan goes.
 *
 * Four levels reaches `layers/<group>/<package>/dist` in this repository's
 * layout, and a workspace that buries a package deeper than that gets a
 * partial mirror rather than a slow one.
 */
const MAX_DEPTH = 4;

export type MirrorOutcome =
  | { kind: 'skipped'; reason: 'no-modules' }
  | { kind: 'mirrored'; copied: number; linked: number };

interface Found {
  /** Paths relative to the source root. */
  outputs: string[];
  modules: string[];
}

function scan(root: string): Found {
  const found: Found = { outputs: [], modules: [] };
  const walk = (relative: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.name === GIT_DIRECTORY) continue;
      // Both of these are destinations, not places to look inside.
      if (entry.name === MODULES_DIRECTORY) {
        found.modules.push(child);
        continue;
      }
      if (entry.name === OUTPUT_DIRECTORY) {
        found.outputs.push(child);
        continue;
      }
      if (depth < MAX_DEPTH) walk(child, depth + 1);
    }
  };
  walk('', 1);
  return found;
}

/**
 * Copies the parent's build output into a worktree and links its modules.
 *
 * Individual failures are counted out rather than thrown: a mirror that lands
 * partly is still better than none, and the caller has a worktree either way.
 */
export function mirrorComposition(source: string, target: string): MirrorOutcome {
  if (!fs.existsSync(path.join(source, MODULES_DIRECTORY))) return { kind: 'skipped', reason: 'no-modules' };

  const found = scan(source);
  let copied = 0;
  let linked = 0;

  for (const relative of found.modules) {
    const destination = path.join(target, relative);
    if (fs.existsSync(destination)) continue;
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(path.join(source, relative), destination, 'dir');
      linked += 1;
    } catch {
      // A link the filesystem refuses costs this package one resolution, not
      // the worktree.
    }
  }

  for (const relative of found.outputs) {
    const destination = path.join(target, relative);
    if (fs.existsSync(destination)) continue;
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(path.join(source, relative), destination, { recursive: true });
      copied += 1;
    } catch {
      // Same reasoning as a failed link.
    }
  }

  return { kind: 'mirrored', copied, linked };
}
