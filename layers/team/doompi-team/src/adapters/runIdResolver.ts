/**
 * Resolve a possibly-abbreviated subagent run id to where its files live.
 *
 * WHY THIS IS SMALLER THAN THE PREDECESSOR:
 * `doom-pi-subagents/src/runs/background/runIdResolver.ts` disambiguates
 * three kinds of run - foreground, async, nested - because that package
 * tracks all three in `SubagentState`. This package is async-only (see
 * `spawnHandshake.ts`'s header) and has not yet ported foreground or nested
 * run tracking (that is later work; see `SubagentState` in the predecessor).
 * This resolver covers the one kind of run this package currently has: a run
 * whose state lives under `currentRunsDir()/<runId>/` and whose terminal result lives
 * in `currentResultsDir()/<runId>.json` until `ResultWatcher` claims it. It is
 * designed to grow, not to be replaced, once the other kinds land.
 *
 * DESIGN PATTERNS:
 * - Aware of `ResultWatcher`'s claim convention
 *   (`currentRunsDir()/<runId>/claimed-result.json`): a run whose result has already
 *   been claimed for delivery must still resolve, and to the claimed copy,
 *   not to a `currentResultsDir()` entry that no longer exists
 * - Prefix matching mirrors the predecessor's ambiguity handling: an
 *   unambiguous prefix resolves like an exact id, an ambiguous one throws
 *   naming every match, and a prefix matching nothing returns `undefined`
 *   rather than throwing - only ambiguity is exceptional, not "not found"
 *
 * AVOID:
 * - Reading `currentResultsDir()/<runId>.json` for a run that `pathExists` shows has
 *   a claimed copy; the source file may already belong to an unrelated, later
 *   run by the time this runs
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { currentResultsDir, currentRunsDir } from './filesystem/paths';
import { CLAIMED_RESULT_FILE_NAME, RESULT_FILE_SUFFIX } from './resultWatcher';

export interface ResolvedRunLocation {
  runId: string;
  /** `currentRunsDir()/<runId>`, when it exists. */
  runDir: string | undefined;
  /** Wherever the run's result currently lives - pending or already claimed. */
  resultPath: string | undefined;
  /** True when `resultPath` is a claimed copy awaiting delivery, not the original. */
  claimed: boolean;
}

export type RunIdResolverContract = {
  /**
   * Resolve an exact id or an unambiguous prefix. `undefined` when nothing
   * matches. Throws when a prefix matches more than one run id.
   */
  resolve(id: string): ResolvedRunLocation | undefined;
  /** Promise-based directory discovery for recurring reconciliation. */
  resolveAsync?(id: string): Promise<ResolvedRunLocation | undefined>;
};

function runDirFor(runId: string): string {
  return path.join(currentRunsDir(), runId);
}

function pendingResultPathFor(runId: string): string {
  return path.join(currentResultsDir(), `${runId}${RESULT_FILE_SUFFIX}`);
}

function claimedResultPathFor(runId: string): string {
  return path.join(runDirFor(runId), CLAIMED_RESULT_FILE_NAME);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

export class RunIdResolver implements RunIdResolverContract {
  // ---------------------------------------------------------------------
  // Filesystem seams. ESM module namespaces are frozen (`vi.spyOn(fs, ...)`
  // throws), so every `node:fs` call a test needs to redirect is wrapped here.
  // ---------------------------------------------------------------------

  protected pathExists(filePath: string): boolean {
    return fs.existsSync(filePath);
  }

  /**
   * Seams for the two directory-listing methods below. A test subclass points these at
   * a directory that does not exist, which exercises the `isNotFound` branch
   * for real without touching the actual shared `currentRunsDir()`/`currentResultsDir()` -
   * closing the only reason this class's tests would otherwise need to.
   */
  protected runsDir(): string {
    return currentRunsDir();
  }

  protected resultsDir(): string {
    return currentResultsDir();
  }

  protected listRunDirNames(): string[] {
    try {
      return fs
        .readdirSync(this.runsDir(), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  protected listPendingResultIds(): string[] {
    try {
      return fs
        .readdirSync(this.resultsDir())
        .filter((entry) => entry.endsWith(RESULT_FILE_SUFFIX))
        .map((entry) => entry.slice(0, -RESULT_FILE_SUFFIX.length));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  resolve(id: string): ResolvedRunLocation | undefined {
    const exact = this.locate(id);
    if (exact) return exact;

    const candidates = this.candidateRunIds().filter((candidate) => candidate.startsWith(id));
    if (candidates.length > 1) {
      throw new Error(`Ambiguous run id prefix '${id}' matched: ${candidates.join(', ')}. Provide a longer id.`);
    }
    const [onlyMatch] = candidates;
    return onlyMatch ? this.locate(onlyMatch) : undefined;
  }

  async resolveAsync(id: string): Promise<ResolvedRunLocation | undefined> {
    const exact = await this.locateAsync(id);
    if (exact) return exact;

    const candidates = (await this.candidateRunIdsAsync()).filter((candidate) => candidate.startsWith(id));
    if (candidates.length > 1) {
      throw new Error(`Ambiguous run id prefix '${id}' matched: ${candidates.join(', ')}. Provide a longer id.`);
    }
    const [onlyMatch] = candidates;
    return onlyMatch ? this.locateAsync(onlyMatch) : undefined;
  }

  private candidateRunIds(): string[] {
    return [...new Set([...this.listRunDirNames(), ...this.listPendingResultIds()])];
  }

  private locate(runId: string): ResolvedRunLocation | undefined {
    const runDir = this.pathExists(runDirFor(runId)) ? runDirFor(runId) : undefined;
    const claimedPath = claimedResultPathFor(runId);
    if (this.pathExists(claimedPath)) {
      return { runId, runDir, resultPath: claimedPath, claimed: true };
    }
    const pendingPath = pendingResultPathFor(runId);
    if (this.pathExists(pendingPath)) {
      return { runId, runDir, resultPath: pendingPath, claimed: false };
    }
    if (runDir) return { runId, runDir, resultPath: undefined, claimed: false };
    return undefined;
  }

  private async pathExistsAsync(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  private async listRunDirNamesAsync(): Promise<string[]> {
    try {
      return (await fs.promises.readdir(this.runsDir(), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  private async listPendingResultIdsAsync(): Promise<string[]> {
    try {
      return (await fs.promises.readdir(this.resultsDir()))
        .filter((entry) => entry.endsWith(RESULT_FILE_SUFFIX))
        .map((entry) => entry.slice(0, -RESULT_FILE_SUFFIX.length));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  private async candidateRunIdsAsync(): Promise<string[]> {
    const [runs, results] = await Promise.all([this.listRunDirNamesAsync(), this.listPendingResultIdsAsync()]);
    return [...new Set([...runs, ...results])];
  }

  private async locateAsync(runId: string): Promise<ResolvedRunLocation | undefined> {
    const runDirectory = runDirFor(runId);
    const claimedPath = claimedResultPathFor(runId);
    const pendingPath = pendingResultPathFor(runId);
    const [hasRunDirectory, hasClaimedResult, hasPendingResult] = await Promise.all([
      this.pathExistsAsync(runDirectory),
      this.pathExistsAsync(claimedPath),
      this.pathExistsAsync(pendingPath),
    ]);
    const runDir = hasRunDirectory ? runDirectory : undefined;
    if (hasClaimedResult) return { runId, runDir, resultPath: claimedPath, claimed: true };
    if (hasPendingResult) return { runId, runDir, resultPath: pendingPath, claimed: false };
    if (runDir) return { runId, runDir, resultPath: undefined, claimed: false };
    return undefined;
  }
}
