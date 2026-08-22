/**
 * Which runs this session started, and which process owns them.
 *
 * WHY A FILE AND NOT THE IN-MEMORY TRACKER:
 * `AsyncJobTracker` already knows this session's runs, but only in memory, and
 * its own header refuses to scan the runs directory to work out ownership. That
 * is the right call for delivery, and useless for the one question that matters
 * at shutdown and after a crash: which pids does this scope still own? A
 * process that died cannot answer, so the answer has to be on disk.
 *
 * REAPING KEYS ON RUN LIVENESS, NOT ON `hostPid` ALONE:
 * The obvious rule - "reap a scope whose owning process is dead" - is wrong.
 * After `/new` the abandoned scope's `hostPid` is the still-live current
 * process, so a hostPid-only test would never reap it. A scope is reapable when
 * none of its recorded pids is alive; a dead `hostPid` only widens that to
 * scopes whose owner is gone entirely.
 *
 * MODELLED ON `doom-runner`'s `RunnerRegistry`, whose `hostPid`-for-orphan-
 * detection and `listBySession` shape this reuses. The containment boundary
 * differs: there it is the worktree, here it is the session scope, which is
 * already a directory.
 *
 * AVOID:
 * - Treating an unreadable registry as empty. Unknown is not the same as none,
 *   and acting on the difference is how a live run gets reaped
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { SESSIONS_ROOT_DIR, type SessionScope, scopeOwnerPath, sessionScopeDir } from './filesystem/paths';
import { parseVersioned } from '../services/support/versioned';
import { writeAtomicJson, writeAtomicJsonAsync } from './atomicJson';
import { readScopeOwner, readScopeOwnerAsync } from './scopeOwner';

const RUN_REGISTRY_VERSION = 1;
const REGISTRY_FILE_NAME = 'registry.json';

export interface RunRecord {
  runId: string;
  /** Process-group leader. Signals are sent to `-pid`. */
  pid: number;
  agent: string;
  runtime: string;
  startedAt: number;
  /** The process that spawned it, for orphan detection after a crash. */
  hostPid: number;
}

interface RunRegistryFile {
  version: typeof RUN_REGISTRY_VERSION;
  runs: RunRecord[];
}

/** Liveness as a port, so a test never probes a real pid. */
export type PidLivenessProbe = (pid: number) => boolean;

export function defaultPidLiveness(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else, which is still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function registryPath(scope: SessionScope): string {
  return path.join(sessionScopeDir(scope), REGISTRY_FILE_NAME);
}

function parseRegistry(raw: string): RunRegistryFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = parseVersioned<RunRegistryFile>(parsed, [RUN_REGISTRY_VERSION]);
  if (!result.ok || !Array.isArray(result.value.runs)) return undefined;
  return result.value;
}

function readRegistry(scope: SessionScope): RunRegistryFile | undefined {
  try {
    return parseRegistry(fs.readFileSync(registryPath(scope), 'utf-8'));
  } catch {
    return undefined;
  }
}

async function readRegistryAsync(scope: SessionScope): Promise<RunRegistryFile | undefined> {
  try {
    return parseRegistry(await fs.promises.readFile(registryPath(scope), 'utf-8'));
  } catch {
    return undefined;
  }
}

function writeRegistry(scope: SessionScope, runs: RunRecord[]): void {
  writeAtomicJson(registryPath(scope), { version: RUN_REGISTRY_VERSION, runs });
}

async function writeRegistryAsync(scope: SessionScope, runs: RunRecord[]): Promise<void> {
  await writeAtomicJsonAsync(registryPath(scope), { version: RUN_REGISTRY_VERSION, runs });
}

/** Record a started run against its scope. Replaces any earlier record for the same id. */
export function registerRun(scope: SessionScope, record: Omit<RunRecord, 'hostPid'>): void {
  const existing = readRegistry(scope)?.runs ?? [];
  const runs = existing.filter((run) => run.runId !== record.runId);
  runs.push({ ...record, hostPid: process.pid });
  writeRegistry(scope, runs);
}

/** Drop one run. Does not signal it; the caller decides that. */
export function releaseRun(scope: SessionScope, runId: string): void {
  const existing = readRegistry(scope)?.runs;
  if (!existing) return;
  writeRegistry(
    scope,
    existing.filter((run) => run.runId !== runId),
  );
}

export function listRuns(scope: SessionScope): RunRecord[] {
  return readRegistry(scope)?.runs ?? [];
}

export async function listRunsAsync(scope: SessionScope): Promise<RunRecord[]> {
  return (await readRegistryAsync(scope))?.runs ?? [];
}

/** Forget records whose process is gone. Returns the run ids dropped. */
export function pruneDeadRuns(scope: SessionScope, isAlive: PidLivenessProbe = defaultPidLiveness): string[] {
  const existing = readRegistry(scope)?.runs;
  if (!existing) return [];
  const live = existing.filter((run) => isAlive(run.pid));
  if (live.length === existing.length) return [];
  writeRegistry(scope, live);
  return existing.filter((run) => !isAlive(run.pid)).map((run) => run.runId);
}

export async function pruneDeadRunsAsync(
  scope: SessionScope,
  isAlive: PidLivenessProbe = defaultPidLiveness,
): Promise<string[]> {
  const existing = (await readRegistryAsync(scope))?.runs;
  if (!existing) return [];
  const dead = existing.filter((run) => !isAlive(run.pid));
  if (dead.length === 0) return [];
  const deadIds = new Set(dead.map((run) => run.runId));
  await writeRegistryAsync(
    scope,
    existing.filter((run) => !deadIds.has(run.runId)),
  );
  return dead.map((run) => run.runId);
}

/**
 * Scopes other than `keep` that hold nothing alive.
 *
 * A scope with no readable owner is skipped rather than reaped: unreadable
 * means unknown, and deleting on unknown is how a live session loses its tree.
 */
export function findReapableScopes(keep: SessionScope, isAlive: PidLivenessProbe = defaultPidLiveness): SessionScope[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(SESSIONS_ROOT_DIR);
  } catch {
    return [];
  }

  const reapable: SessionScope[] = [];
  for (const scopeKey of entries) {
    if (scopeKey === keep.scopeKey) continue;
    const candidate: SessionScope = { rootSessionId: '', scopeKey };
    const owner = readScopeOwner(candidate);
    if (!owner) continue;
    const scope: SessionScope = { rootSessionId: owner.rootSessionId, scopeKey };
    if (listRuns(scope).some((run) => isAlive(run.pid))) continue;
    reapable.push(scope);
  }
  return reapable;
}

export async function findReapableScopesAsync(
  keep: SessionScope,
  isAlive: PidLivenessProbe = defaultPidLiveness,
): Promise<SessionScope[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(SESSIONS_ROOT_DIR);
  } catch {
    return [];
  }

  const reapable: SessionScope[] = [];
  for (const scopeKey of entries) {
    if (scopeKey === keep.scopeKey) continue;
    const candidate: SessionScope = { rootSessionId: '', scopeKey };
    const owner = await readScopeOwnerAsync(candidate);
    if (!owner) continue;
    const scope: SessionScope = { rootSessionId: owner.rootSessionId, scopeKey };
    if ((await listRunsAsync(scope)).some((run) => isAlive(run.pid))) continue;
    reapable.push(scope);
  }
  return reapable;
}

/** Remove a scope's whole tree. Only ever called on a scope `findReapableScopes` returned. */
export function reapScope(scope: SessionScope): boolean {
  try {
    fs.rmSync(sessionScopeDir(scope), { recursive: true, force: true });
    return true;
  } catch {
    // Best effort: a tree that resists removal is reconsidered on the next
    // sweep, and its owner file still reads as reapable, which is the safe
    // direction for this to fail in.
    void scopeOwnerPath(scope);
    return false;
  }
}

export async function reapScopeAsync(scope: SessionScope): Promise<boolean> {
  try {
    await fs.promises.rm(sessionScopeDir(scope), { recursive: true, force: true });
    return true;
  } catch {
    void scopeOwnerPath(scope);
    return false;
  }
}
