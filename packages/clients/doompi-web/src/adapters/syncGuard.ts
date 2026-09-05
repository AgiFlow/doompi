import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describeSyncDrift, readSyncDrift, readSyncRegistration } from '@agimon-ai/doompi/services';
import { findRepositoryRoot } from '@agimon-ai/doompi/utils';
import { repositoryDoomPiCli } from './bundledServer.ts';
import { webHostPackageRoot } from './webPluginGenerate.ts';

const DOOMPI_PACKAGE = '@agimon-ai/doompi';
const AGENT_COMMAND_ENV = 'DOOMPI_AGENT_COMMAND';
const SYNC_COMMAND_ENV = 'DOOMPI_SYNC_COMMAND';
const BOOTSTRAP_ENTRY_ENV = 'DOOMPI_BOOTSTRAP_ENTRY';
const HARNESS_ROOT_ENV = 'DOOMPI_ROOT';
const WEB_PACKAGE_ROOT_ENV = 'DOOMPI_WEB_PACKAGE_ROOT';
const CLI_SEGMENTS = ['dist', 'bin', 'cli.mjs'];
const SYNC_ARGS = ['sync'];
/** How often the watcher re-reads the drift inputs. */
const WATCH_INTERVAL_MS = 2_000;
/** Ceiling for the retry delay after a sync that keeps failing. */
const MAX_RETRY_INTERVAL_MS = 60_000;

/** What one sync attempt did, so a failure is never reported as a rebuild. */
export interface SyncRunOutcome {
  ok: boolean;
  detail?: string;
}

export interface SyncGuardOptions {
  /** Known repository root, or a launch directory to discover one from. */
  repoRoot?: string;
  cwd?: string;
  onNotice?: (message: string) => void;
  /** Test seam for running the sync itself; returning nothing reads as success. */
  runSync?: (repoRoot: string) => Promise<SyncRunOutcome | void>;
  /** Test seam for the per-repository drift read and launcher-owned Doom entry. */
  readDrift?: (repoRoot: string, expectedBootstrapEntry?: string) => { fresh: boolean; reasons: readonly string[] };
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

/**
 * The DoomPi CLI this repository should sync with.
 *
 * A repository that pins its own DoomPi must be synced by that one: extensions
 * are version-coupled to the harness that resolves them, and the copy sitting
 * in the hub's dependency tree may not be the copy the repository runs.
 */
function syncCliFor(repoRoot: string): string {
  return (
    process.env[SYNC_COMMAND_ENV] ??
    repositoryDoomPiCli(repoRoot) ??
    process.env[AGENT_COMMAND_ENV] ??
    path.join(path.dirname(createRequire(import.meta.url).resolve(`${DOOMPI_PACKAGE}/package.json`)), ...CLI_SEGMENTS)
  );
}

/** Runs the launcher's own sync, in its own process so the hub keeps serving. */
function spawnSync(repoRoot: string): Promise<SyncRunOutcome> {
  const cli = syncCliFor(repoRoot);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...SYNC_ARGS], {
      cwd: repoRoot,
      env: {
        ...process.env,
        [HARNESS_ROOT_ENV]: repoRoot,
        [WEB_PACKAGE_ROOT_ENV]: process.env[WEB_PACKAGE_ROOT_ENV] || webHostPackageRoot(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tail: string[] = [];
    const keep = (chunk: Buffer): void => {
      tail.push(chunk.toString());
      if (tail.length > 20) tail.shift();
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    // A failed sync is reported, not thrown: the session the caller wanted still
    // starts, and it starts against whatever the last good sync left. What it
    // must not do is claim the artifacts were rebuilt.
    child.once('error', (error) => resolve({ ok: false, detail: `it could not start: ${error.message}` }));
    child.once('exit', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, detail: `exit ${String(code)}: ${tail.join('').trim().slice(-400)}` });
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
  const runSync = options.runSync ?? ((root: string) => spawnSync(root));
  const expectedBootstrapEntry = process.env[BOOTSTRAP_ENTRY_ENV];
  const readDrift =
    options.readDrift ??
    ((root: string, entry?: string) => {
      const drift = readSyncDrift({ repoRoot: root, expectedBootstrapEntry: entry });
      // A CLI-only sync is valid for the terminal, but cannot supply session UI.
      if (drift.fresh && readSyncRegistration(root)?.webDirectory == null) {
        return { fresh: false, reasons: ['cockpit-bundle-missing'] };
      }
      return drift;
    });
  const baseInterval = options.intervalMs ?? WATCH_INTERVAL_MS;
  let inFlight: Promise<{ ready: boolean; rebuilt: boolean; error?: string }> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let consecutiveFailures = 0;
  let lastFailureNotice: string | undefined;

  /**
   * One sync attempt, reporting whether it actually rebuilt anything.
   *
   * A sync that exits non-zero published nothing, so saying "complete" and
   * telling every attached page to reload is two lies and a reload storm: the
   * repository is still drifted, so the next poll tries again immediately.
   */
  const failedResult = (failure: string): { ready: false; rebuilt: false; error: string } => {
    consecutiveFailures += 1;
    // The same failure every few seconds buries everything else in the log.
    if (failure !== lastFailureNotice) {
      notice(failure);
      lastFailureNotice = failure;
    }
    return { ready: false, rebuilt: false, error: failure };
  };

  const syncOnce = async (drift: {
    reasons: readonly string[];
  }): Promise<{ ready: boolean; rebuilt: boolean; error?: string }> => {
    notice(`syncing: ${describeSyncDrift({ fresh: false, reasons: drift.reasons as never })}`);
    let outcome: SyncRunOutcome;
    try {
      outcome = (await runSync(repoRoot)) ?? { ok: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return failedResult(`sync failed (${detail})`);
    }
    if (!outcome.ok) return failedResult(`sync failed (${outcome.detail ?? 'no detail'})`);

    const remaining = readDrift(repoRoot, expectedBootstrapEntry);
    if (!remaining.fresh) {
      return failedResult(
        `sync completed but did not resolve drift (${describeSyncDrift({ fresh: false, reasons: remaining.reasons as never })})`,
      );
    }
    consecutiveFailures = 0;
    lastFailureNotice = undefined;
    notice('sync complete');
    return { ready: true, rebuilt: true };
  };

  const ensureSynced = async (): Promise<{ ready: boolean; rebuilt: boolean; error?: string }> => {
    if (closed) return { ready: false, rebuilt: false, error: 'sync guard is closed' };
    // Joining the run already in flight is what makes concurrent launches
    // wait for one sync instead of starting several.
    if (inFlight) return inFlight;
    const drift = readDrift(repoRoot, expectedBootstrapEntry);
    if (drift.fresh) return { ready: true, rebuilt: false };
    inFlight = syncOnce(drift).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  return {
    async ensureSynced() {
      const result = await ensureSynced();
      if (!result.ready) throw new Error(`DoomPi cannot launch this session because ${result.error ?? 'sync failed'}.`);
    },
    watch(onSynced) {
      if (timer) return;
      const schedule = (): void => {
        if (closed) return;
        // Backing off after a failure: a repository that cannot sync will not
        // start syncing because it was asked again two seconds later, and the
        // retries drown the reason in the log.
        const delay = Math.min(baseInterval * 2 ** consecutiveFailures, MAX_RETRY_INTERVAL_MS);
        timer = setTimeout(tick, delay);
        // The hub should not be held open by its own watcher.
        timer.unref?.();
      };
      const tick = (): void => {
        if (closed || inFlight) {
          schedule();
          return;
        }
        const drift = readDrift(repoRoot, expectedBootstrapEntry);
        if (drift.fresh) {
          schedule();
          return;
        }
        void ensureSynced().then((result) => {
          if (!closed && result.rebuilt) onSynced();
          schedule();
        });
      };
      schedule();
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
