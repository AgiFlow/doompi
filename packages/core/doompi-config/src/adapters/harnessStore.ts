import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HarnessState } from '../types/config.ts';
import { writePrivateAtomicJson } from './atomicJson.ts';
import {
  HARNESS_STATE_KEYS,
  type HarnessStateParseReporter,
  projectHarnessEnvironment,
  readHarnessState,
} from './harnessState.ts';

/**
 * Who owns the harness state, and where it lives.
 *
 * The state used to be the environment: twenty variables that every reader
 * re-parsed and every writer mutated globally. The file is the authority now,
 * and the environment is a projection published for the readers that can only
 * see an environment, which are bash hooks, the shell launchers, packages that
 * do not depend on this one, and any process spawned by any of them.
 *
 * OWNERSHIP IS PER PROCESS, AND THAT IS THE WHOLE DESIGN:
 * Doom Team subagents run detached, in their own process group, from an
 * environment snapshot taken at spawn. A child can outlive its parent. If it
 * shared the parent's file it would corrupt a session it does not own, and if
 * that file sat in the parent's run directory the parent's shutdown sweep would
 * delete it from under a live run. So every process writes a file it owns:
 * `owner.pid` records who, and a process that finds someone else's file copies
 * it before its first write.
 *
 * AVOID:
 * - Treating the file as shared mutable state between processes. Atomic writes
 *   prevent torn reads, not lost updates
 * - Reading the environment directly for anything this exposes
 */

/** Points at the state file. The one variable that is not derived. */
export const HARNESS_STATE_POINTER = 'DOOMPI_STATE';

const STATE_FILE_VERSION = 1;
const STATE_FILE_NAME = 'harness-state.json';
const ADOPTED_DIRECTORY = 'doom-harness';
/**
 * Written for a process that does not exist yet, so the first one to read it
 * owns it. A spawner cannot know its child's pid, and a child that inherited
 * its parent's file would lose it the moment the parent cleaned up.
 */
const UNCLAIMED_OWNER = 0;

export interface HarnessStateFile {
  version: number;
  owner: { pid: number; startedAt: string };
  state: HarnessState;
}

export interface HarnessStateTransactionSnapshot {
  readonly filePath?: string;
  readonly owned: boolean;
  readonly state: HarnessState;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface LoadedHarnessState {
  /** Undefined when this process is running off the environment fallback. */
  filePath?: string;
  owned: boolean;
  state: HarnessState;
}

let loaded: LoadedHarnessState | undefined;

/** Drops the cached state. For tests, and for a process changing identity. */
export function resetHarnessStore(): void {
  loaded = undefined;
}

function parseStateFile(source: string, filePath: string): HarnessStateFile {
  const parsed = JSON.parse(source) as Partial<HarnessStateFile>;
  if (parsed.version !== STATE_FILE_VERSION) {
    throw new Error(
      `Harness state at ${filePath} has version ${String(parsed.version)}, expected ${STATE_FILE_VERSION}`,
    );
  }
  if (typeof parsed.state !== 'object' || parsed.state === null) {
    throw new Error(`Harness state at ${filePath} has no state object`);
  }
  return {
    version: STATE_FILE_VERSION,
    owner: { pid: parsed.owner?.pid ?? -1, startedAt: parsed.owner?.startedAt ?? '' },
    state: parsed.state as HarnessState,
  };
}

/**
 * Reads the state for this process, once.
 *
 * A missing pointer means nobody wrote a file for this process, so the
 * environment is all there is: a nested run, a third-party spawn, or a caller
 * older than the store. A pointer that cannot be read is reported and then
 * treated the same way, because a session that starts degraded beats a session
 * that does not start at all.
 */
export function loadHarnessState(
  environment: NodeJS.ProcessEnv = process.env,
  report?: HarnessStateParseReporter,
): LoadedHarnessState {
  // The cache describes this process. Asking about another environment is a
  // question about another process, so it reads through rather than answering
  // from what this one happens to hold.
  const cacheable = environment === process.env;
  if (cacheable && loaded) return loaded;

  const filePath = environment[HARNESS_STATE_POINTER];
  let result: LoadedHarnessState | undefined;
  if (filePath && fs.existsSync(filePath)) {
    try {
      const file = parseStateFile(fs.readFileSync(filePath, 'utf8'), filePath);
      const owned = file.owner.pid === process.pid || file.owner.pid === UNCLAIMED_OWNER;
      result = { filePath, owned, state: file.state };
    } catch (error) {
      report?.(HARNESS_STATE_POINTER, error);
    }
  }
  result ??= { owned: false, state: readHarnessState(environment, report) };
  if (cacheable) loaded = result;
  return result;
}

/** Captures the owned state pointer and every projected harness variable. */
export function snapshotHarnessState(environment: NodeJS.ProcessEnv = process.env): HarnessStateTransactionSnapshot {
  const loadedState = loadHarnessState(environment);
  const environmentSnapshot: Record<string, string | undefined> = {
    [HARNESS_STATE_POINTER]: environment[HARNESS_STATE_POINTER],
  };
  for (const key of Object.values(HARNESS_STATE_KEYS)) environmentSnapshot[key] = environment[key];
  return {
    filePath: loadedState.filePath,
    owned: loadedState.owned,
    state: structuredClone(loadedState.state),
    environment: environmentSnapshot,
  };
}

/** Restores a snapshot only while the current process still owns its state pointer. */
export function restoreHarnessStateSnapshot(
  snapshot: HarnessStateTransactionSnapshot,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const current = loadHarnessState(environment);
  if (snapshot.filePath && snapshot.owned) {
    if (!current.owned || current.filePath !== snapshot.filePath) {
      throw new Error('Harness state ownership changed; refusing to restore an older snapshot.');
    }
    persist(snapshot.filePath, snapshot.state);
  } else if (!snapshot.filePath) {
    if (current.filePath && !current.owned) {
      throw new Error('Harness state is no longer owned by this process; refusing to restore an older snapshot.');
    }
    if (current.filePath && current.owned) fs.rmSync(current.filePath, { force: true });
    resetHarnessStore();
  } else if (current.filePath !== snapshot.filePath) {
    throw new Error('Harness state pointer changed; refusing to restore an older snapshot.');
  }
  for (const [key, value] of Object.entries(snapshot.environment)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  if (environment === process.env) {
    loaded = snapshot.filePath
      ? { filePath: snapshot.filePath, owned: snapshot.owned, state: snapshot.state }
      : undefined;
  }
}

export function getHarnessState(report?: HarnessStateParseReporter): HarnessState {
  return loadHarnessState(process.env, report).state;
}

function stateFilePath(directory: string): string {
  return path.join(directory, STATE_FILE_NAME);
}

/** Where a process writes state when it was not given a file of its own. */
function adoptedStateFilePath(): string {
  return path.join(os.tmpdir(), ADOPTED_DIRECTORY, `${String(process.pid)}.json`);
}

function persist(filePath: string, state: HarnessState, ownerPid = process.pid): void {
  writePrivateAtomicJson(filePath, {
    version: STATE_FILE_VERSION,
    owner: { pid: ownerPid, startedAt: new Date().toISOString() },
    state,
  } satisfies HarnessStateFile);
}

/**
 * Starts a session: writes the file and publishes the derived environment.
 *
 * The environment is a parameter because the caller is usually describing a
 * process other than itself. The launcher builds the environment for the Pi it
 * is about to spawn, and Doom Team builds the snapshot for a detached child, so
 * neither should touch its own `process.env` to do it.
 */
export function createHarnessSession(
  state: HarnessState,
  options: {
    directory: string;
    environment: NodeJS.ProcessEnv;
    /**
     * Leave the file for a process that does not exist yet to claim.
     *
     * What a spawner wants: the child owns its state from its first read, in a
     * directory the spawner manages, so the parent cleaning up its own session
     * cannot pull the file out from under a detached run.
     */
    unclaimed?: boolean;
  },
): string {
  const filePath = stateFilePath(options.directory);
  persist(filePath, state, options.unclaimed ? UNCLAIMED_OWNER : process.pid);
  options.environment[HARNESS_STATE_POINTER] = filePath;
  projectHarnessEnvironment(state, options.environment);
  // Only prime the cache when this process is the one being described.
  if (!options.unclaimed && options.environment === process.env) loaded = { filePath, owned: true, state };
  return filePath;
}

/**
 * Applies a patch to this process's state.
 *
 * Copy on write: a process holding a file it does not own writes its own copy
 * and repoints itself at it, so a child can never rewrite its parent's session.
 */
export function updateHarnessState(
  patch: Partial<HarnessState>,
  environment: NodeJS.ProcessEnv = process.env,
): HarnessState {
  const current = loadHarnessState(environment);
  const state = { ...current.state, ...patch };
  const filePath = current.owned && current.filePath ? current.filePath : adoptedStateFilePath();
  persist(filePath, state);
  environment[HARNESS_STATE_POINTER] = filePath;
  if (environment === process.env) loaded = { filePath, owned: true, state };
  projectHarnessEnvironment(patch, environment);
  return state;
}

/** Removes this process's own state file. Safe when there is none. */
export function disposeHarnessState(environment: NodeJS.ProcessEnv = process.env): void {
  const current = loaded;
  resetHarnessStore();
  if (!current?.owned || !current.filePath) return;
  fs.rmSync(current.filePath, { force: true });
  delete environment[HARNESS_STATE_POINTER];
}

export function harnessRoot(state: Pick<HarnessState, 'root'> = getHarnessState()): string {
  return state.root ?? process.cwd();
}

/**
 * The repository root, or a hard error.
 *
 * Separate from `requireHarnessPaths` because most callers only need the root,
 * and separate from `harnessRoot` because falling back to `process.cwd()` would
 * quietly operate on whatever directory the session happens to sit in. A caller
 * that asks for the root wants the session's repository or nothing.
 */
export function requireHarnessRoot(state: Pick<HarnessState, 'root'> = getHarnessState()): string {
  if (!state.root) throw new Error(`${HARNESS_STATE_KEYS.root} is not set`);
  return state.root;
}

/** The root and the run's scratch directory, for callers that write to disk. */
export function requireHarnessPaths(state: Pick<HarnessState, 'root' | 'temporaryDirectory'> = getHarnessState()): {
  root: string;
  temporaryDirectory: string;
} {
  const root = requireHarnessRoot(state);
  if (!state.temporaryDirectory) throw new Error(`${HARNESS_STATE_KEYS.temporaryDirectory} is not set`);
  return { root, temporaryDirectory: state.temporaryDirectory };
}
