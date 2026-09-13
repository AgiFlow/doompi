import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Remove the state sessions left behind when they never got to clean up.
 *
 * A session clears its own timeline and snapshots on shutdown, which covers the
 * ordinary case and nothing else: a killed process, a crash, or a machine that
 * lost power leaves both behind, and nothing ever looked at the directory
 * again. One week of that filled a real checkout with hundreds of megabytes.
 *
 * Age is the only signal used, because it is the only one that is true from
 * another process. A running session appends as it works, so its timeline is
 * recent; a dead one stops moving at the moment it died.
 */

/**
 * How long state may sit untouched before a later session removes it.
 *
 * Generous on purpose. The cost of waiting is disk, and the cost of being wrong
 * is deleting a live session's history, so this is set far beyond any plausible
 * gap between two appends rather than close to it.
 */
export const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const TIMELINE_SUFFIX = '.jsonl';
const SNAPSHOTS_SUFFIX = '.blobs';

export interface SweepSessionStateOptions {
  directory: string;
  /** The caller's own timeline, which is never a candidate however it looks. */
  keep?: string;
  /** Remove the directory itself once nothing is left in it. */
  removeDirectory?: boolean;
  now?: number;
  maxAgeMs?: number;
}

async function remove(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

/** The most recent time anything under this session's state moved. */
async function lastTouched(paths: readonly string[]): Promise<number | undefined> {
  let newest: number | undefined;
  for (const target of paths) {
    try {
      const stat = await fs.stat(target);
      if (newest === undefined || stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch {
      // Not there is not a reason to keep the rest.
    }
  }
  return newest;
}

/** How many sessions' worth of state was removed. */
export async function sweepSessionState(options: SweepSessionStateOptions): Promise<number> {
  const { directory, keep, removeDirectory = false, now = Date.now(), maxAgeMs = STATE_MAX_AGE_MS } = options;
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return 0;
  }
  const floor = now - maxAgeMs;
  const timelines = new Set(entries.filter((entry) => entry.endsWith(TIMELINE_SUFFIX)));
  let removed = 0;

  for (const entry of timelines) {
    const timelinePath = path.join(directory, entry);
    if (keep !== undefined && timelinePath === keep) continue;
    const snapshotsPath = `${timelinePath.slice(0, -TIMELINE_SUFFIX.length)}${SNAPSHOTS_SUFFIX}`;
    const lockPath = `${timelinePath}.lock`;
    const touched = await lastTouched([timelinePath, snapshotsPath, lockPath]);
    if (touched === undefined || touched >= floor) continue;
    // Content first. A crash between the two leaves a timeline whose snapshots
    // are gone, which reads as a session whose diffs expired. The other order
    // leaves a blob tree nothing will ever name again, which is the shape of
    // the leak this exists to clear.
    await remove(snapshotsPath);
    await remove(timelinePath);
    await remove(lockPath);
    removed += 1;
  }

  // A blob tree whose timeline is already gone is exactly what a half-finished
  // cleanup leaves, and nothing else will ever look for it.
  for (const entry of entries) {
    if (!entry.endsWith(SNAPSHOTS_SUFFIX)) continue;
    if (timelines.has(`${entry.slice(0, -SNAPSHOTS_SUFFIX.length)}${TIMELINE_SUFFIX}`)) continue;
    const orphan = path.join(directory, entry);
    const touched = await lastTouched([orphan]);
    if (touched === undefined || touched >= floor) continue;
    await remove(orphan);
  }

  if (removeDirectory) {
    try {
      await fs.rmdir(directory);
    } catch {
      // Still holding something, so it is not this sweep's to remove.
    }
  }
  return removed;
}
