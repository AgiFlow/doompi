/**
 * Filesystem roots for every artifact this package writes outside the project.
 *
 * DESIGN PATTERNS:
 * - One root, derived subdirectories. Nothing else in the package joins
 *   `os.tmpdir()` directly, so the whole tree can be relocated from here
 * - The root is scoped per operating-system user. A shared `/tmp` on a
 *   multi-user host would otherwise let one user read another's run state, and
 *   worse, let two users collide on the same run id
 *
 * The root is named for this package, not for its predecessor. That is what
 * keeps a doom-team parent and a doom-pi-subagents parent from reading each
 * other's channels while both are installed during cutover.
 *
 * AVOID:
 * - Joining `os.tmpdir()` anywhere else
 * - Putting a user-supplied string into a path segment without sanitizing it
 */

import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

import { SUBAGENT_ROOT_SESSION_ENV } from '../../types/environment';

const TEMP_ROOT_PREFIX = 'doom-team';
const UNKNOWN_SCOPE_SEGMENT = 'unknown';
const SHARED_SCOPE_ID = 'shared';
const SCOPE_ENV_KEYS = ['USERNAME', 'USER', 'LOGNAME'] as const;

/** Reduce a value to a single safe path segment. */
function sanitizeTempScopeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return sanitized || UNKNOWN_SCOPE_SEGMENT;
}

/** The identity sources used to scope the temp root, in preference order. */
export interface TempScopeSources {
  env?: NodeJS.ProcessEnv;
  getuid?: (() => number) | undefined;
  userInfo?: (() => { username?: string | null }) | undefined;
  homedir?: (() => string) | undefined;
}

/**
 * Identify the current user for temp-root scoping.
 *
 * The uid is preferred because it cannot be spoofed by the environment. The
 * remaining sources are progressively weaker fallbacks for platforms that do
 * not expose one; `shared` is the last resort and is deliberately reachable, so
 * a run never fails purely because the user could not be identified.
 */
export function resolveTempScopeId(options?: TempScopeSources): string {
  const env = options?.env ?? process.env;
  const getuid = options && Object.hasOwn(options, 'getuid') ? options.getuid : process.getuid?.bind(process);
  if (typeof getuid === 'function') return `uid-${getuid()}`;

  for (const key of SCOPE_ENV_KEYS) {
    const value = env[key];
    if (value) return `user-${sanitizeTempScopeSegment(value)}`;
  }

  const userInfo = options && Object.hasOwn(options, 'userInfo') ? options.userInfo : os.userInfo;
  try {
    const username = userInfo?.().username;
    if (username) return `user-${sanitizeTempScopeSegment(username)}`;
  } catch {
    // os.userInfo throws when the uid has no passwd entry; scope by home instead.
  }

  const homedir = env.USERPROFILE ?? env.HOME;
  if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;

  const resolveHomedir = options && Object.hasOwn(options, 'homedir') ? options.homedir : os.homedir;
  try {
    const fallbackHomedir = resolveHomedir?.();
    if (fallbackHomedir) return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
  } catch {
    // Every identity source failed; fall back to the shared scope.
  }

  return SHARED_SCOPE_ID;
}

/** Root of this package's out-of-project state, scoped to the current user. */
export const TEMP_ROOT_DIR = path.join(os.tmpdir(), `${TEMP_ROOT_PREFIX}-${resolveTempScopeId()}`);

/** Artifacts produced by runs whose artifact preference resolves to `temp`. */
export const TEMP_ARTIFACTS_DIR = path.join(TEMP_ROOT_DIR, 'artifacts');

// ============================================================================
// Session scope
// ============================================================================

/**
 * Everything a session owns lives under one directory named for that session.
 *
 * WHY THIS EXISTS:
 * These paths used to be flat constants under `TEMP_ROOT_DIR`, shared by every
 * concurrent session of the same user. That is not merely untidy: with one
 * shared `run-results/`, a session could win `ResultWatcher`'s atomic-rename
 * claim on a run it did not own, and then never deliver it, because the
 * consumer's "not mine" answer is the same `false` that means "retry later".
 * `tests/unit/sessionIsolation.test.ts` reproduces exactly that. Scoping the
 * read paths removes the race by construction rather than by teaching the
 * consumer to distinguish two meanings of `false`.
 *
 * THE KEY IS THE ROOT SESSION, NOT THIS PROCESS'S SESSION:
 * A spawned child has its own Pi session id, so it cannot derive the tree from
 * `SessionManager.getSessionId()` - it would land in a directory of its own and
 * see none of its parent's state. The ROOT session id travels down by
 * environment instead, which is the same thing `nativeTeamChannel.ts` already
 * does for team membership.
 *
 * AVOID:
 * - Reading another scope's tree for anything except reaping. Cross-scope reads
 *   are what this whole layout exists to prevent
 */
export interface SessionScope {
  /** Pi's session id for the session at the top of this process tree. */
  rootSessionId: string;
  /** `rootSessionId` reduced to one safe path segment. */
  scopeKey: string;
}

const SESSIONS_DIR_NAME = 'sessions';
const SCOPE_KEY_HASH_LENGTH = 16;

/** All scopes. Only a reaping sweep may read across this; never a delivery path. */
export const SESSIONS_ROOT_DIR = path.join(TEMP_ROOT_DIR, SESSIONS_DIR_NAME);

/**
 * Hashed rather than sanitized: a Pi session id is a uuidv7 today, but the id
 * is also settable by a caller (`SessionManager.newSession({ id })`), and a
 * hash is the only derivation that cannot collide two different ids onto one
 * directory after sanitizing away their differing characters.
 */
export function sessionScopeKey(rootSessionId: string): string {
  return createHash('sha256').update(rootSessionId).digest('hex').slice(0, SCOPE_KEY_HASH_LENGTH);
}

export function createSessionScope(rootSessionId: string): SessionScope {
  const trimmed = rootSessionId.trim();
  if (!trimmed) throw new Error('A session scope requires a non-empty root session id.');
  return { rootSessionId: trimmed, scopeKey: sessionScopeKey(trimmed) };
}

/** `sessions/<scopeKey>`. Every other scoped path derives from this one. */
export function sessionScopeDir(scope: SessionScope): string {
  return path.join(SESSIONS_ROOT_DIR, scope.scopeKey);
}

/** Records which session and process own a scope, so a later sweep can reap it. */
export function scopeOwnerPath(scope: SessionScope): string {
  return path.join(sessionScopeDir(scope), 'owner.json');
}

/** Terminal run results, written once by the runner and read by this scope's parent only. */
export function scopeResultsDir(scope: SessionScope): string {
  return path.join(sessionScopeDir(scope), 'run-results');
}

/** Per-run working state: status.json, transcripts, control inboxes, claimed results. */
export function scopeRunsDir(scope: SessionScope): string {
  return path.join(sessionScopeDir(scope), 'runs');
}

/** Team member records, heartbeats, inboxes and replies for this scope's team. */
export function scopeTeamDir(scope: SessionScope): string {
  return path.join(sessionScopeDir(scope), 'team');
}

/** Runs stopped by a session shutdown, awaiting an explicit restore. */
export function scopeSuspendedDir(scope: SessionScope): string {
  return path.join(sessionScopeDir(scope), 'suspended');
}

/**
 * Scratch space for launching a child: its prompt, task and tool diagnostics.
 *
 * Callers `mkdtemp` inside this rather than in `os.tmpdir()` directly, so the
 * scoping applies to launch scratch too. These files carry the full task text,
 * which is exactly the content that should not be world-readable.
 */
export function scopeChildLaunchTempDir(scope: SessionScope): string {
  return path.join(sessionScopeDir(scope), 'child-launch');
}

/**
 * Path of the launch config handed to a detached runner.
 *
 * These files carry the full launch contract, so the runner's spawn site writes
 * them 0600 and the parent removes them once the child has read them.
 */
export function getRunConfigPath(scope: SessionScope, runId: string): string {
  return path.join(sessionScopeDir(scope), 'launch', `${runId}.json`);
}

// ============================================================================
// The process's current scope
// ============================================================================

/**
 * One process serves exactly one root session at a time, so the scope is
 * process state rather than a parameter on every path call.
 *
 * WHY THIS IS SETTABLE AND NOT A CONSTANT:
 * `TEMP_ROOT_DIR` can be a constant because the OS user is fixed for the life
 * of the process. The root session is not: a parent learns it at
 * `session_start`, and Pi fires that again with a DIFFERENT session id after
 * `/new`, `/resume` and `/fork` (it builds a fresh `SessionManager` each time).
 * A child learns it from the environment its parent spawned it with.
 *
 * WHY AN UNSET SCOPE THROWS RATHER THAN FALLING BACK:
 * A silent fallback to an unscoped directory is exactly the shared-state bug
 * this layout removes, and it would fail invisibly - two sessions quietly
 * sharing a tree again. Every real code path runs after either `session_start`
 * or child bootstrap, so reaching a path helper with no scope is a wiring bug
 * and should say so.
 *
 * AVOID:
 * - Reading this at module scope. It is not set at import time
 */
let currentScope: SessionScope | undefined;

export function setCurrentSessionScope(scope: SessionScope): void {
  currentScope = scope;
}

/** Test-only, and for a child that legitimately has no team root forwarded. */
export function clearCurrentSessionScope(): void {
  currentScope = undefined;
}

export function tryCurrentSessionScope(): SessionScope | undefined {
  return currentScope;
}

export function requireCurrentSessionScope(): SessionScope {
  if (!currentScope) {
    throw new Error(
      'No session scope is set. The parent sets it on session_start; a child sets it from its spawn environment.',
    );
  }
  return currentScope;
}

/** `run-results/` for this process's scope. */
export function currentResultsDir(): string {
  return scopeResultsDir(requireCurrentSessionScope());
}

/** `runs/` for this process's scope. */
export function currentRunsDir(): string {
  return scopeRunsDir(requireCurrentSessionScope());
}

/** `child-launch/` for this process's scope. */
export function currentChildLaunchTempDir(): string {
  return scopeChildLaunchTempDir(requireCurrentSessionScope());
}

/** `suspended/` for this process's scope. */
export function currentSuspendedDir(): string {
  return scopeSuspendedDir(requireCurrentSessionScope());
}

/** Launch config path for a run in this process's scope. */
export function currentRunConfigPath(runId: string): string {
  return getRunConfigPath(requireCurrentSessionScope(), runId);
}

/** Folded into a spawned child's environment so it resolves the same tree. */
export function sessionScopeEnvironment(scope: SessionScope): Record<string, string> {
  return { [SUBAGENT_ROOT_SESSION_ENV]: scope.rootSessionId };
}

/** The scope a spawned child inherits, or undefined in a process nothing spawned. */
export function resolveSessionScopeFromEnv(env: NodeJS.ProcessEnv = process.env): SessionScope | undefined {
  const rootSessionId = env[SUBAGENT_ROOT_SESSION_ENV]?.trim();
  return rootSessionId ? createSessionScope(rootSessionId) : undefined;
}

/**
 * Adopt the inherited scope, if this process was spawned with one.
 *
 * Returns whether a scope was adopted, so a child entry point can fail loudly
 * rather than silently writing into an unscoped tree.
 */
export function adoptSessionScopeFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const scope = resolveSessionScopeFromEnv(env);
  if (!scope) return false;
  setCurrentSessionScope(scope);
  return true;
}
