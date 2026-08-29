import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describeSyncDrift, readSyncDrift } from '@agimon-ai/doompi/services';
import { findRepositoryRoot } from '@agimon-ai/doompi/utils';

const DOOMPI_PACKAGE = '@agimon-ai/doompi';
const CLI_SEGMENTS = ['dist', 'bin', 'cli.mjs'];
const SYNC_ARGS = ['sync'];
/** How often the watcher re-reads the drift inputs. */
const WATCH_INTERVAL_MS = 2_000;

export interface SyncGuardOptions {
  /** Known repository root, or a launch directory to discover one from. */
  repoRoot?: string;
  cwd?: string;
  onNotice?: (message: string) => void;
  /** Test seam for running the sync itself. */
  runSync?: (repoRoot: string) => Promise<void>;
  /** Test seam for the drift read. */
  readDrift?: (repoRoot: string) => { fresh: boolean; reasons: readonly string[] };
  /** Test seam over repository discovery. */
  findRoot?: (cwd: string) => string;
  intervalMs?: number;
}
export interface SyncGuard {
  /**
   * Syncs the repository when anything a session reads has drifted.
   *
   * Serialized: several sessions starting at once wait on one sync rather
   * than racing to rebuild the same artifacts over each other.
   */
  ensureSynced(): Promise<void>;
  /** Re-syncs on drift and reports when artifacts changed under a running cockpit. */
  watch(onSynced: () => void): void;
  close(): void;
}

function inactiveSyncGuard(): SyncGuard {
  return {
    ensureSynced: async () => {},
    watch: () => {},
    close: () => {},
  };
}

/** Runs the launcher's own sync, in its own process so the hub keeps serving. */
function spawnSync(repoRoot: string, onNotice: (message: string) => void): Promise<void> {
  const cli = path.join(
    path.dirname(createRequire(import.meta.url).resolve(`${DOOMPI_PACKAGE}/package.json`)),
    ...CLI_SEGMENTS,
  );
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...SYNC_ARGS], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail: string[] = [];
    const keep = (chunk: Buffer): void => {
      tail.push(chunk.toString());
      if (tail.length > 20) tail.shift();
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.once('error', (error) => {
      onNotice(`sync could not start: ${error.message}`);
      resolve();
    });
    child.once('exit', (code) => {
      // A failed sync is reported, not thrown: the session the caller wanted
      // still starts, and it starts against whatever the last good sync left.
      if (code !== 0) onNotice(`sync exited ${String(code)}: ${tail.join('').trim().slice(-400)}`);
      resolve();
    });
  });
}

/**
 * Keeps the repository synced under a running cockpit.
 *
 * A session launched from the browser reads what sync produced: the resolved
 * composition, the plugin bundle, and the package API routes. Nothing forces
 * a person clicking "new session" to have run sync first, and a stale one
 * fails quietly rather than loudly, so the hub checks and syncs itself.
 */
export function createSyncGuard(options: SyncGuardOptions): SyncGuard {
  const notice = options.onNotice ?? ((): void => {});
  let repoRoot = options.repoRoot;
  if (repoRoot === undefined) {
    try {
      repoRoot = (options.findRoot ?? findRepositoryRoot)(options.cwd ?? process.cwd());
    } catch {
      return inactiveSyncGuard();
    }
  }
  const runSync = options.runSync ?? ((root: string) => spawnSync(root, notice));
  const readDrift = options.readDrift ?? ((root: string) => readSyncDrift({ repoRoot: root }));
  let inFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const syncOnce = async (drift: { reasons: readonly string[] }): Promise<void> => {
    notice(`syncing: ${describeSyncDrift({ fresh: false, reasons: drift.reasons as never })}`);
    await runSync(repoRoot);
    notice('sync complete');
  };

  const ensureSynced = async (): Promise<void> => {
    if (closed) return;
    // Joining the run already in flight is what makes concurrent launches
    // wait for one sync instead of starting several.
    if (inFlight) return inFlight;
    const drift = readDrift(repoRoot);
    if (drift.fresh) return;
    inFlight = syncOnce(drift).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    ensureSynced,
    watch(onSynced) {
      if (timer) return;
      timer = setInterval(() => {
        if (closed || inFlight) return;
        const drift = readDrift(repoRoot);
        if (drift.fresh) return;
        void ensureSynced().then(() => {
          if (!closed) onSynced();
        });
      }, options.intervalMs ?? WATCH_INTERVAL_MS);
      // The hub should not be held open by its own watcher.
      timer.unref?.();
    },
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
